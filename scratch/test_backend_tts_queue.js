const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

console.log('Testing live backend TTS queue with 10 concurrent HTTP requests on PORT 3099...');

const TEST_PORT = 3099;
const serverProcess = spawn('node', ['backend/server.js'], {
  env: { ...process.env, PORT: TEST_PORT.toString() },
  cwd: path.resolve('.')
});

let serverStarted = false;
serverProcess.stdout.on('data', (d) => {
  const msg = d.toString();
  if (msg.includes('DR Dubber Pro Server running') || msg.includes('localhost:')) {
    serverStarted = true;
  }
});
serverProcess.stderr.on('data', (d) => {
  // console.error('[Server Err]', d.toString());
});

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`http://localhost:${TEST_PORT}`, (r) => res(r));
        req.on('error', rej);
      });
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return false;
}

async function run() {
  const ready = await waitForServer();
  if (!ready) {
    console.error('Server failed to start on test port 3099');
    serverProcess.kill();
    process.exit(1);
  }

  console.log('Backend server is live on port 3099. Sending 10 concurrent /api/generate-audio requests...');

  const sampleTexts = [
    'សួស្តីបងប្អូនទាំងអស់គ្នា',
    'សូមស្វាគមន៍មកកាន់កម្មវិធី',
    'ការបង្កើតសំឡេងដោយស្វ័យប្រវត្តិ',
    'នេះគឺជាការសាកល្បងប្រព័ន្ធ',
    'ដំណើរការលឿន និងត្រឹមត្រូវ',
    'សូមអរគុណសម្រាប់ការគាំទ្រ',
    'ជួបគ្នាពេលក្រោយទៀត',
    'ភាពយន្តភាគពិសេសសម្រាប់អ្នក',
    'បច្ចេកវិទ្យាជំនាន់ថ្មីបំផុត',
    'សំឡេងច្បាស់ល្អឥតខ្ចោះ'
  ];

  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  const t0 = Date.now();

  const reqPromises = sampleTexts.map((text, idx) => {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        text: text,
        voice: 'km-KH-PisethNeural',
        speed: 1.0,
        pitch: 0,
        volume: 0,
        index: `queue_test_${idx}`
      });

      const req = http.request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/generate-audio',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          completed++;
          try {
            const data = JSON.parse(body);
            if (res.statusCode === 200 && data.success) {
              succeeded++;
              console.log(`  [Req ${idx + 1}/10] ✅ Success: duration=${data.duration}s in ${(Date.now() - t0)}ms`);
            } else {
              failed++;
              console.error(`  [Req ${idx + 1}/10] ❌ Failed: HTTP ${res.statusCode}`, data.error || body);
            }
          } catch (e) {
            failed++;
            console.error(`  [Req ${idx + 1}/10] ❌ JSON Parse Error:`, body);
          }
          resolve();
        });
      });

      req.on('error', (err) => {
        completed++;
        failed++;
        console.error(`  [Req ${idx + 1}/10] ❌ Network Error:`, err.message);
        resolve();
      });

      req.write(payload);
      req.end();
    });
  });

  await Promise.all(reqPromises);

  console.log(`\nResults: ${succeeded} succeeded, ${failed} failed out of 10 requests in ${Date.now() - t0}ms`);
  serverProcess.kill();

  if (succeeded === 10 && failed === 0) {
    console.log('🎉 LIVE BACKEND QUEUE TEST PASSED: 100% SUCCESS RATE UNDER HIGH LOAD!');
    process.exit(0);
  } else {
    console.error('💥 TEST FAILED!');
    process.exit(1);
  }
}

run();
