const fs = require('fs');
const script = fs.readFileSync('script.js', 'utf8');
const elements = {
  roster: { innerHTML: '' },
  chatlog: { textContent: '', scrollTop:0, scrollHeight:0 },
  map: {
    clientWidth: 400,
    clientHeight: 300,
    width: 0,
    height: 0,
    classList: { add(){}, remove(){} },
    getContext(){ return { clearRect(){}, strokeRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fill(){}, arc(){}, fillText(){}, font:'', fillStyle:'', lineWidth:1, strokeStyle:'' }; },
    setPointerCapture(){}, releasePointerCapture(){},
    addEventListener(){},
    getBoundingClientRect(){ return { left:0, top:0 }; }
  },
  status: { textContent:'', style:{} },
  mapReset: { onclick:null },
  pauseOn: { onclick:null },
  pauseOff: { onclick:null },
  allowBtn: { onclick:null },
  allowName: { value:'' },
  chatSend: { onclick:null },
  chatMsg: { value:'' }
};
const document = {
  getElementById(id){ return elements[id] || null; }
};
const window = {};
function EventSource(url){ this.url = url; this.addEventListener = ()=>{}; }
function requestAnimationFrame(fn){ /* ignore */ }
try {
  new Function('document','window','EventSource','requestAnimationFrame', script)(document, window, EventSource, requestAnimationFrame);
  console.log('runtime ok');
} catch(err) {
  console.error('runtime error', err);
}
