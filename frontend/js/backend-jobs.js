// Requests to the local backend that must not hold a connection open.
//
// Chromium opens at most 6 connections to localhost:3001. Dub Whole Series transcribing 6 tabs
// at once kept all of them busy for minutes, and every other request (progress, audio, the
// joining part) queued behind them until the browser failed them with
// net::ERR_INSUFFICIENT_RESOURCES.
(function () {
  "use strict";

  const JSON_HEADERS = { "Content-Type": "application/json" };
  const RESULT_POLL_MS = 1000;
  const RESULT_TIMEOUT_MS = 10000;
  // The backend can stop answering for a while (a busy machine); give up only after this long.
  const BACKEND_GONE_MS = 2 * 60 * 1000;

  const abortError = (signal) => signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError(signal)); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body ?? {}), { status, headers: JSON_HEADERS });

  // POSTs a JSON body to a backgroundable route (/api/transcribe, /api/repair-subtitles): the
  // server answers at once, and the result is collected from /api/job-result. Resolves to a
  // Response like fetch() does (same status and JSON body); `signal` aborts the wait like it
  // aborts a fetch (the server's work is stopped with /api/cancel-transcribe, as before).
  async function postJob(url, { body, signal } = {}) {
    const jobId = crypto.randomUUID();
    const started = await fetch(url, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Background-Job": jobId },
      body,
      signal,
    });
    const first = await started.json().catch(() => null);
    if (!first?.background) return jsonResponse(first, started.status);

    const resultUrl = `${new URL(url, location.href).origin}/api/job-result?id=${encodeURIComponent(jobId)}`;
    let failingSince = 0;
    for (;;) {
      await sleep(RESULT_POLL_MS, signal);
      let data;
      try {
        const res = await fetch(resultUrl, { signal: AbortSignal.any([AbortSignal.timeout(RESULT_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
        data = await res.json();
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        failingSince = failingSince || Date.now();
        if (Date.now() - failingSince > BACKEND_GONE_MS) throw new Error("The backend stopped answering.");
        continue;
      }
      failingSince = 0;
      if (data.unknown) throw new Error("The backend lost this job (was it restarted?).");
      if (data.done) return jsonResponse(data.body, data.status);
    }
  }

  // setInterval for a progress poll: a tick is skipped while the last one is still waiting, so
  // requests can't pile up when the backend is slow to answer, and `fn` gets a signal that gives
  // up on its request after a while. Returns a normal interval id (stop it with clearInterval).
  function pollEvery(ms, fn) {
    let busy = false;
    return setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await fn(AbortSignal.timeout(Math.max(8000, ms * 4)));
      } catch (e) {
      } finally {
        busy = false;
      }
    }, ms);
  }

  window.backendJobs = { postJob, pollEvery };
})();
