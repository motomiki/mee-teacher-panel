const fs = require('fs');
const script = fs.readFileSync('script.js', 'utf8');

const listeners = {};
const eventSourceStub = function(url){
  return {
    addEventListener(type, handler){
      listeners[type] = handler;
    }
  };
};

const rosterEl = { innerHTML: '' };
const chatEl = { textContent: '', scrollTop: 0, scrollHeight: 0 };
const statusEl = { textContent: '', style: {} };

const mapEl = {
  width: 0,
  height: 0,
  clientWidth: 400,
  clientHeight: 300,
  classList: { add(){}, remove(){} },
  setPointerCapture(){},
  releasePointerCapture(){},
  addEventListener(){},
  getBoundingClientRect(){ return { left:0, top:0 }; },
  getContext(){
    return {
      clearRect(){},
      fillRect(){},
      fillText(){},
      strokeRect(){},
      beginPath(){},
      moveTo(){},
      lineTo(){},
      stroke(){},
      arc(){},
      fill(){},
      set fillStyle(v){},
      set strokeStyle(v){},
      set lineWidth(v){},
      set font(v){},
      set lineCap(v){}
    };
  }
};

const docStub = {
  getElementById(id){
    if(id === 'roster') return rosterEl;
    if(id === 'chatlog') return chatEl;
    if(id === 'map') return mapEl;
    if(id === 'status') return statusEl;
    if(id === 'mapReset') return { onclick:null };
    if(id === 'pauseOn' || id === 'pauseOff' || id === 'allowBtn' || id === 'chatSend') {
      return { onclick: null };
    }
    if(id === 'allowName') return { value: '' };
    if(id === 'chatMsg') return { value: '' };
    return {};
  }
};

function raf(cb){
  setTimeout(()=>cb(Date.now()), 0);
}

new Function('document','window','EventSource','requestAnimationFrame', script)(docStub, {}, eventSourceStub, raf);

console.log('executed script ok');
if(listeners.state){
  listeners.state({ data: JSON.stringify({ roster:[{name:'Alice', lastSeen: Date.now(), pos:{x:0,y:64,z:0}}], chat:[], pauseOn:false }) });
  console.log('roster html', rosterEl.innerHTML);
}
