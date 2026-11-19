// Runs at most getMax() tasks at once; the rest wait in order. getMax is read each time a slot
// frees, so a changed limit (Settings > Performance) applies to the next task.
function createLimiter(getMax) {
    let active = 0;
    const waiting = [];

    const max = () => Math.max(1, Math.floor(Number(typeof getMax === 'function' ? getMax() : getMax)) || 1);

    function pump() {
        while (active < max() && waiting.length) {
            const next = waiting.shift();
            if (next.signal && next.signal.aborted) {
                next.reject(abortError());
                continue;
            }
            active++;
            next.start();
        }
    }

    function abortError() {
        const e = new Error('Stopped');
        e.name = 'AbortError';
        return e;
    }

    // Runs task() when a slot is free. A signal that aborts while it waits ends the wait.
    function run(task, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(abortError());
            const entry = {
                signal,
                reject,
                // The slot is free again before the caller hears the answer.
                start: () => {
                    const done = () => { active--; pump(); };
                    Promise.resolve().then(task).then(
                        (v) => { done(); resolve(v); },
                        (e) => { done(); reject(e); },
                    );
                },
            };
            if (signal) {
                signal.addEventListener('abort', () => {
                    const i = waiting.indexOf(entry);
                    if (i >= 0) {
                        waiting.splice(i, 1);
                        reject(abortError());
                    }
                }, { once: true });
            }
            waiting.push(entry);
            pump();
        });
    }

    return { run, get active() { return active; }, get waiting() { return waiting.length; } };
}

module.exports = { createLimiter };
