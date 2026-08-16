const fs = require('fs');
const path = require('path');

const renderJs = fs.readFileSync(path.join(__dirname, 'backend', 'render_service.js'), 'utf8');

console.log(renderJs.substring(3000, 7000));
