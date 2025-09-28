const fs = require('fs');
const script = fs.readFileSync('script.js', 'utf8');
try {
  new Function('document','window','EventSource','requestAnimationFrame', script);
  console.log('compile ok');
} catch(err) {
  console.error('compile error', err);
}
