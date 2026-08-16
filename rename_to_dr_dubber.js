const fs = require('fs');
const path = require('path');

// 1. Update frontend/index.html
const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

indexHtml = indexHtml.replace(/<title>DAI Dubber Pro<\/title>/gi, '<title>DR Dubber Pro</title>');
indexHtml = indexHtml.replace(/DAI Dubber \+ PRO/g, 'DR Dubber + PRO');
indexHtml = indexHtml.replace(/DAI Dubber Pro/g, 'DR Dubber Pro');
indexHtml = indexHtml.replace(/DAI Dubber/g, 'DR Dubber');

fs.writeFileSync(indexHtmlPath, indexHtml, 'utf8');
console.log('Updated frontend/index.html to DR Dubber Pro');

// 2. Update package.json
const pkgPath = path.join(__dirname, 'package.json');
let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = "dr-dubber-pro";
pkg.productName = "DR Dubber Pro";
pkg.description = "DR Dubber Pro - Khmer Edition AI Dubbing Studio";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
console.log('Updated package.json to DR Dubber Pro');

// 3. Update backend/server.js console logs & titles
const serverPath = path.join(__dirname, 'backend', 'server.js');
let serverJs = fs.readFileSync(serverPath, 'utf8');
serverJs = serverJs.replace(/\[DAI Dubber Pro Server\]/g, '[DR Dubber Pro Server]');
fs.writeFileSync(serverPath, serverJs, 'utf8');
console.log('Updated backend/server.js');

// 4. Update main.js
const mainPath = path.join(__dirname, 'main.js');
let mainJs = fs.readFileSync(mainPath, 'utf8');
mainJs = mainJs.replace(/title:\s*['"][^'"]*['"]/g, "title: 'DR Dubber Pro'");
fs.writeFileSync(mainPath, mainJs, 'utf8');
console.log('Updated main.js');
