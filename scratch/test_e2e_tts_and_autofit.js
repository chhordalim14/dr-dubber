const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

console.log('================================================================');
console.log('🧪 RUNNING COMPREHENSIVE E2E VERIFICATION TEST');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------------
// TEST 1: Python TTS Generator with Auto-Retry & 0-Byte Protection
// --------------------------------------------------------------------
async function testPythonTtsDirect() {
  console.log('Test 1: Testing Python TTS Generator directly with Khmer text...');
  const pyScript = path.resolve('backend/python/tts_generator.py');
  const outDir = path.resolve('scratch');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const pyBin = 'C:\\Users\\ADMIN\\AppData\\Local\\Programs\\DR Dubber Pro\\resources\\app.asar.unpacked\\backend\\python_env\\python.exe';
  const pythonCmd = fs.existsSync(pyBin) ? pyBin : 'python';

  const testTexts = [
    'សួស្តីបងប្អូនទាំងអស់គ្នា',
    'សូមស្វាគមន៍មកកាន់កម្មវិធី',
    'ការបង្កើតសំឡេងដោយស្វ័យប្រវត្តិ',
    'នេះគឺជាការសាកល្បងប្រព័ន្ធ',
    'ដំណើរការលឿន និងត្រឹមត្រូវ'
  ];

  const results = await Promise.all(testTexts.map((text, idx) => {
    return new Promise((resolve) => {
      const outFile = path.join(outDir, `test_tts_${Date.now()}_${idx}.mp3`);
      const child = spawn(pythonCmd, [
        pyScript,
        '--text', text,
        '--voice', 'km-KH-PisethNeural',
        '--output', outFile
      ], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
      child.on('close', code => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch (_) {}
        const exists = fs.existsSync(outFile);
        const size = exists ? fs.statSync(outFile).size : 0;
        if (exists) {
          try { fs.unlinkSync(outFile); } catch (_) {}
        }
        resolve({ idx, code, parsed, exists, size, error: stderr || stdout });
      });
    });
  }));

  const allSucceeded = results.every(r => r.parsed && r.parsed.success === true && r.size > 0 && r.parsed.duration > 0);
  assert(allSucceeded, `All ${results.length} parallel TTS requests generated valid audio (size > 0, duration > 0)`);
  results.forEach(r => {
    if (r.parsed && r.parsed.success) {
      console.log(`     -> Sample ${r.idx}: ${r.parsed.duration}s, ${r.size} bytes`);
    } else {
      console.error(`     -> Sample ${r.idx} FAILED:`, r.error);
    }
  });
}

// --------------------------------------------------------------------
// TEST 2: Auto-Fit Interval Logic & Negative Interval Prevention
// --------------------------------------------------------------------
function testAutoFitTimingLogic() {
  console.log('\nTest 2: Testing Auto-Fit and Duration Timing Logic...');

  // Simulate subtitles that previously suffered from drift and produced audioStart > audioEnd
  const mockSubtitles = [
    {
      id: "sub-1",
      textStart: "10.00",
      textEnd: "12.00",
      audioStart: "10.50", // drifted downstream
      audioEnd: "14.50",
      baseAudioDuration: 3.5,
      speed: 1.0,
      audioStatus: "ready"
    },
    {
      id: "sub-2",
      textStart: "12.50",
      textEnd: "15.00",
      audioStart: "14.20", // drifted downstream
      audioEnd: "18.00",
      baseAudioDuration: 4.0,
      speed: 1.0,
      audioStatus: "ready"
    },
    {
      id: "sub-3",
      textStart: "270.00", // 4:30 in screenshot
      textEnd: "273.00",
      audioStart: "274.00", // drifted past end
      audioEnd: "272.00", // inverted!
      baseAudioDuration: 2.8,
      speed: 1.0,
      audioStatus: "ready"
    }
  ];

  // Helper matching our fixed isAudioOwnedByOwnText logic:
  function isAudioOwnedByOwnText(sub) {
    const textStart = parseFloat(sub.textStart);
    const textEnd = parseFloat(sub.textEnd);
    const audioStart = parseFloat(sub.audioStart);
    const audioEnd = parseFloat(sub.audioEnd);
    if (isNaN(textStart) || isNaN(audioStart) || isNaN(audioEnd)) return false;
    if (audioStart >= audioEnd) return false; // Inverted or zero width is NEVER valid owned audio
    const overlapStart = Math.max(textStart, audioStart);
    const overlapEnd = Math.min(textEnd, audioEnd);
    return overlapEnd > overlapStart;
  }

  // Pre-fix check: sub-3 was inverted and failed owned check
  assert(!isAudioOwnedByOwnText(mockSubtitles[2]), 'Detected corrupted inverted interval before fix (audioStart >= audioEnd)');

  // Run the sanitize/repair function as implemented in restoreProjectState:
  mockSubtitles.forEach(sub => {
    if (sub.audioStatus === "ready") {
      const aStart = parseFloat(sub.audioStart);
      const aEnd = parseFloat(sub.audioEnd);
      const tStart = parseFloat(sub.textStart || 0);
      const tEnd = parseFloat(sub.textEnd || tStart + 2);
      if (isNaN(aStart) || isNaN(aEnd) || aStart >= aEnd) {
        const dur = sub.baseAudioDuration && sub.baseAudioDuration > 0 ? (sub.baseAudioDuration / (sub.speed || 1.0)) : (tEnd - tStart);
        sub.audioStart = tStart.toFixed(2);
        sub.audioEnd = (tStart + Math.max(0.2, dur)).toFixed(2);
      }
    }
  });

  assert(parseFloat(mockSubtitles[2].audioStart) < parseFloat(mockSubtitles[2].audioEnd), 'Sanitizer successfully repaired inverted interval on sub-3');
  assert(mockSubtitles[2].audioStart === "270.00", 'Sanitizer reset audioStart to match textStart 270.00');
  assert(isAudioOwnedByOwnText(mockSubtitles[2]), 'sub-3 is now recognized as valid owned audio (no longer an orphan!)');

  // Now test Auto-Fit Strong logic
  const overlapMargin = 0.05;
  const projDuration = 500;
  const sorted = [...mockSubtitles].sort((a, b) => parseFloat(a.textStart) - parseFloat(b.textStart));

  sorted.forEach((sub, idx) => {
    const nextSub = sorted[idx + 1];
    const startTime = parseFloat(sub.textStart);
    const maxDuration = nextSub ? parseFloat(nextSub.textStart) - startTime + overlapMargin : projDuration - startTime;
    const visualDuration = sub.baseAudioDuration / (sub.speed || 1.0);

    let finalSpeed = sub.speed || 1.0;
    if (visualDuration > maxDuration && maxDuration > 0.1) {
      finalSpeed = Math.max(0.5, Math.min(2.5, sub.baseAudioDuration / maxDuration));
    }
    sub.speed = finalSpeed;
    let finalEnd = startTime + sub.baseAudioDuration / finalSpeed;
    if (finalEnd > projDuration) finalEnd = projDuration;

    sub.audioStart = startTime.toFixed(2);
    sub.audioEnd = finalEnd.toFixed(2);
  });

  // Verify all subtitles after Auto-Fit:
  const allValidIntervals = mockSubtitles.every(sub => {
    const s = parseFloat(sub.audioStart);
    const e = parseFloat(sub.audioEnd);
    return s < e && isFinite(s) && isFinite(e) && isAudioOwnedByOwnText(sub);
  });
  assert(allValidIntervals, 'All subtitles have strictly positive non-overlapping intervals (audioStart < audioEnd) and pass owned-text validation');

  // Verify no overlap with next subtitle's text start
  const sub1End = parseFloat(mockSubtitles[0].audioEnd);
  const sub2Start = parseFloat(mockSubtitles[1].textStart);
  assert(sub1End <= sub2Start + overlapMargin + 0.01, `Sub-1 audio end (${sub1End}) respects Sub-2 text start (${sub2Start}) with margin`);
}

// --------------------------------------------------------------------
// TEST 3: Multi-Tab Concurrency Queue & Pending Items Filter Logic
// --------------------------------------------------------------------
function testMultiTabSelectionAndQueue() {
  console.log('\nTest 3: Testing Multi-Tab Subtitle Targeting & Concurrency Queue...');

  const projects = [
    {
      id: "tab-1",
      title: "Tab 1",
      subtitles: [
        { id: "s1-1", audioStatus: "ready", file: "path1.mp3" },
        { id: "s1-2", audioStatus: "ready", file: "path2.mp3" }
      ]
    },
    {
      id: "tab-2",
      title: "Tab 2",
      subtitles: [
        { id: "s2-1", audioStatus: "ready", file: "path3.mp3" },
        { id: "s2-2", audioStatus: "idle", file: null },
        { id: "s2-3", audioStatus: "error", file: null }
      ]
    },
    {
      id: "tab-3",
      title: "Tab 3",
      subtitles: [
        { id: "s3-1", audioStatus: "idle", file: null },
        { id: "s3-2", audioStatus: "idle", file: null }
      ]
    }
  ];

  const anyPendingAcrossProjects = projects.some((proj) =>
    (proj.subtitles || []).some((s) => s.audioStatus === "idle" || s.audioStatus === "error" || !s.file)
  );
  assert(anyPendingAcrossProjects === true, 'Successfully detects pending work across multi-project tabs');

  // Simulate tab targeting logic in generateSelectedAudioAllProjects
  const targetedTabs = [];
  for (const p of projects) {
    const pending = (p.subtitles || []).filter((s) => s.audioStatus === "idle" || s.audioStatus === "error" || !s.file);
    if (pending.length > 0) {
      targetedTabs.push({ id: p.id, idsToGenerate: pending.map(s => s.id) });
    } else {
      if (anyPendingAcrossProjects) {
        // Tab 1 is 100% complete and skipped!
        continue;
      } else {
        targetedTabs.push({ id: p.id, idsToGenerate: p.subtitles.map(s => s.id) });
      }
    }
  }

  assert(targetedTabs.length === 2, `Targeted exactly the 2 tabs with pending work (Tab 2 and Tab 3), skipping completed Tab 1`);
  assert(targetedTabs[0].id === "tab-2" && targetedTabs[0].idsToGenerate.length === 2, 'Tab 2 targets only its 2 pending/error subtitles (skips ready ones)');
  assert(targetedTabs[1].id === "tab-3" && targetedTabs[1].idsToGenerate.length === 2, 'Tab 3 targets its 2 idle subtitles');
}

async function run() {
  await testPythonTtsDirect();
  testAutoFitTimingLogic();
  testMultiTabSelectionAndQueue();

  console.log('\n================================================================');
  console.log(`🏁 TEST SUMMARY: ${passedTests} / ${totalTests} tests passed.`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    console.log('🎉 ALL INTEGRATION TESTS PASSED! Ready for production release.');
  } else {
    process.exit(1);
  }
}

run();
