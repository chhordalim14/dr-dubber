const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const headEnd = indexHtml.indexOf('</head>');
console.log("=== HEAD SCRIPTS & LINKS ===");
const head = indexHtml.substring(0, headEnd);
const scriptMatches = head.match(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b[^>]*\/>|<link\b[^>]*>/gi);
console.log(scriptMatches);
