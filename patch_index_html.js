const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Fix tempA in generate-audio response
const oldChunk1 = `const tempA = new Audio(\`http://localhost:3001\${freshUrl}\`);`;
const newChunk1 = `const resolvedMetaUrl = freshUrl.startsWith("http") ? freshUrl : \`http://localhost:3001\${freshUrl}\`;
                  const tempA = new Audio(resolvedMetaUrl);`;

// 2. Fix tempA in VoxCPM2 generation response
const oldChunk2 = `const tempA = new Audio(\`http://localhost:3001\${freshUrl}\`);`;

// Replace safeIndex immediate duration assignment
const oldImmediate = `if (!targetSubs[safeIndex].audioEnd) targetSubs[safeIndex].audioEnd = targetSubs[safeIndex].textEnd;`;
const newImmediate = `if (data.duration && data.duration > 0) {
                    targetSubs[safeIndex].baseAudioDuration = data.duration;
                    targetSubs[safeIndex].audioEnd = (startTime + data.duration).toFixed(2);
                  } else if (!targetSubs[safeIndex].audioEnd) {
                    targetSubs[safeIndex].audioEnd = targetSubs[safeIndex].textEnd;
                  }`;

let count1 = 0;
while (content.includes(oldChunk1)) {
    content = content.replace(oldChunk1, newChunk1);
    count1++;
}

let count2 = 0;
if (content.includes(oldImmediate)) {
    content = content.replace(oldImmediate, newImmediate);
    count2++;
}

fs.writeFileSync(filePath, content, 'utf8');
console.log(`Updated index.html: replaced tempA (${count1} times), immediate duration (${count2} times).`);
