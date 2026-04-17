const fs = require('fs');
let content = fs.readFileSync('public/script.js', 'utf8');
content = content.replace(/isAnimatingPan = false;/g, 'isAnimatingPan = false;\n            syncBoardBackground();');
fs.writeFileSync('public/script.js', content);
