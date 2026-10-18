// Dub Whole Series, hands-free: which pauses continue by themselves after a wait (Google's quota,
// Google busy, the network) and which wait for a person (Settings, engines, the VoxCPM2 server).
// autoResumeKind is lifted out of frontend/js/studio-main.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');
const quotaMsg = source.match(/const QUOTA_MSG = ("[^"]+");/)[1];
const start = source.indexOf('const autoResumeKind = (msg) => {');
const end = source.indexOf('\n      };', start) + '\n      };'.length;
const autoResumeKind = new Function(`const QUOTA_MSG = ${quotaMsg}; ${source.slice(start, end)} return autoResumeKind;`)();

test('Google\'s daily quota waits and continues', () => {
    assert.equal(autoResumeKind(JSON.parse(quotaMsg)), 'quota');
    assert.equal(autoResumeKind('Google reports the daily free Gemini quota used up for key …abcd'), 'quota');
});

test('busy, rate limits, network and lines that failed for those reasons continue after a short wait', () => {
    for (const m of [
        'Gemini did not respond within 240s - Google is busy',
        'Cannot reach Google Gemini (ETIMEDOUT). Check your internet connection / VPN / firewall.',
        'Lost track of the joining job.',
        '12 line(s) still have no voice after 3 tries. Press Continue to try them again.',
        'Transcribe did not start (see the message above).',
        'Failed to fetch'
    ]) assert.equal(autoResumeKind(m), 'other', m);
});

test('anything a person has to fix still waits for Continue', () => {
    for (const m of [
        "Set the 'Generated Audio Temp Path' in Settings.",
        'Start the VoxCPM2 server first.',
        'Tab 1, 2: MDX-Net could not run (model missing). Fix it or switch engine in Settings, then press Continue.',
        'Tab 3: the subtitles could not be found (no video). Fix it, or switch "Blur subtitles" off, then press Continue.',
        'The open tabs were not closed.',
        'No tab could be joined for some unknown reason'
    ]) assert.equal(autoResumeKind(m), null, m);
});

test('only hands-free continues by itself, with a cap per part, and a click on Continue cancels the wait', () => {
    assert.match(source, /const kind = handsFree\(\) && plan \? \(kindOverride \|\| autoResumeKind\(e && e\.message\)\) : null;/);
    assert.match(source, /if \(tries >= AUTO_RESUME_MAX\[kind\]\) return 0;/);
    assert.match(source, /plan\.autoResume = null; \/\/ a new part starts with its own auto-continue tries/);
    assert.match(source, /if \(!auto\) cancelAutoResume\(\);/);
});

test('each kind of pause keeps its own count, so alternating pauses still reach their limit', () => {
    assert.match(source, /const counts = \{ \.\.\.\(plan\.autoResume\?\.counts \|\| \{\}\) \};\n\s+const tries = counts\[kind\] \|\| 0;/);
});

test('another job running is checked again later (counted), a missing setting is not retried', () => {
    assert.match(source, /if \(auto && otherJobRunning\(\)\) \{/);
    assert.match(source, /scheduleAutoResume\(\{ message: opts\.reason \|\| "Another job was running\." \}, "busy"\)/);
    assert.match(source, /if \(!preflight\(\)\) return; \/\/ a setting is missing/);
});

test('Reset and Start over hold the countdown while their confirm is open', () => {
    assert.equal((source.match(/const resume = holdAutoResume\(\);/g) || []).length, 2);
    assert.equal((source.match(/if \(!ok\) return resume\(\);\n\s+if \(seriesRun\) return;/g) || []).length, 2);
});

test('hands-free export: only the part\'s own tabs, tagged with this series run, and Stop only stops series exports', () => {
    assert.match(source, /plan\.lastDone = \{ index: i, steps: plan\.stepState, pieces: plan\.pieces \};/);
    assert.match(source, /queueAllTabs\(`\$\{plan\.outDir\}\|\$\{plan\.id \|\| ""\}\|part\$\{i \+ 1\}`, pieces \|\| null, seriesExportDir\(\) \|\| null\)/);
    assert.match(source, /if \(onlyPaths && !onlyPaths\.includes\(proj\.videoFilePath\)\) return;/);
    assert.match(source, /if \(job\.rendering\) window\.seriesRenderApi\?\.stopItems\(job\.items\);/);
});
