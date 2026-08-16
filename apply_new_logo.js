const fs = require('fs');
const path = require('path');

// 1. Copy new logo
const userLogoPath = 'C:\\Users\\KOLDER\\.gemini\\antigravity-ide\\brain\\e91592e6-939c-41b4-8257-e31123ab6474\\.user_uploaded\\media_1786891929026.jpg';

const destinations = [
    path.join(__dirname, 'frontend', 'daidubberpro.png'),
    path.join(__dirname, 'frontend', 'drdubberpro.png'),
    path.join(__dirname, 'assets', 'daidubberpro.png'),
    path.join(__dirname, 'assets', 'drdubberpro.png'),
    path.join(__dirname, 'frontend', 'assets', 'drdubberpro.png')
];

destinations.forEach(dest => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(userLogoPath, dest);
    console.log(`Copied new logo to: ${dest}`);
});

// 2. Update index.html to use drdubberpro.png and update alt tags
const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

html = html.replace(/src="daidubberpro\.png"/g, 'src="drdubberpro.png"');
fs.writeFileSync(indexHtmlPath, html, 'utf8');
console.log('Updated index.html logo src references to drdubberpro.png');
