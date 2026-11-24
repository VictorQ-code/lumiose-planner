/* Capa en vivo del visor: lee data/gold/barcelona/vivo/ (lo que escribe pipeline/vivo.py) y lo dibuja.
   - Tráfico: cada tramo municipal pintado según su estado (de lejos) y la densidad/velocidad de los vehículos.
   - Vehículos: 5 modelos de coche y 5 de autobús circulando por la red viaria (red.json), simulados con el tráfico real.
   - Bicing: barras por estación (mecánicas en rojo, eléctricas en azul).
   - Tiempo: en el panel.
   Cada capa nueva = un manejador en H[nombre]. index.html solo expone window.CITY3D y llama a los frameHooks. */
(function(){
'use strict';
const K=window.CITY3D; if(!K||!K.CITY) return;
const THREE=K.THREE, U=K.U, INK=K.INK, LDIR=K.LDIR;
const VIVO=K.BASE+'vivo/';
const VEH_MPP=2.2;                 // por debajo de esto (m/px) circulan coches y buses (de lejos, como puntitos: la ciudad nunca se ve quieta)
const PARK_MPP=1.1;                // los aparcados solo de cerca: de lejos no aportan y son miles
let VSC=1;                         // de lejos los vehículos en marcha se dibujan algo más grandes para que se distingan
const MOVIL=!!K.movil;             // móvil o tablet: menos vehículos y personas a la vez
const CAR_CAP=900, BUS_CAP=110, MOVE_CAP=MOVIL?550:1200, PARK_CAP=MOVIL?1200:2500;   // por modelo: circulando y aparcados (aparte)
const TX=window.T||((es)=>es), NUM=window.NUM||(n=>Number(n).toLocaleString('es'));     // idioma (lo define index.html)
const HI_MPP=0.32;                 // por debajo: modelo con todo el detalle; por encima, simplificado
const POLL_MS=30000;

const store={get(k,d){ try{ const v=localStorage.getItem('vivo.'+k); return v===null?d:v==='1'; }catch(e){ return d; } },
             set(k,v){ try{ localStorage.setItem('vivo.'+k,v?'1':'0'); }catch(e){} }};
const ON={trafico:store.get('trafico',true),vehiculos:store.get('vehiculos',true),bicing:store.get('bicing',true),personas:store.get('personas',true)};
const root=new THREE.Group(); K.scene.add(root);
const vehGroup=new THREE.Group(), ribbonGroup=new THREE.Group(), bikeGroup=new THREE.Group();
root.add(vehGroup,ribbonGroup,bikeGroup);

/* ================= Sombreado (mismo lenguaje que el resto del visor) ================= */
const NOISE=`float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}`;
const HATCH=`float hatch(vec2 uv,float ang,float w,float sp){ vec2 d=vec2(cos(ang),sin(ang));
  float c=dot(uv,d)/sp+(noise(uv*0.35/sp)-0.5)*0.7; float dist=abs(fract(c)-0.5); float aa=fwidth(c)*0.9+0.001;
  return 1.0-smoothstep(w-aa,w+aa,dist); }`;
const ROT=`vec3 rotY(vec3 p,float a){ float c=cos(a),s=sin(a); return vec3(p.x*c+p.z*s,p.y,-p.x*s+p.z*c); }`;
const Y0=0.36;   // encima de la calzada y de las marcas viales

// Vehículos con THREE.InstancedMesh (instanceMatrix + instanceColor), el mismo mecanismo que los trenes del metro
const vehMat=new THREE.ShaderMaterial({
  uniforms:{ink:{value:INK},L:{value:LDIR},sp:U.sp,hatchOn:U.hatchOn},
  vertexShader:`attribute vec3 aCol; attribute float aBody; attribute float aTint;
    varying vec3 vN; varying vec3 vW; varying vec3 vC; varying float vT;
    void main(){ vec4 w=modelMatrix*instanceMatrix*vec4(position,1.0); vW=w.xyz;
      vN=normalize(mat3(modelMatrix)*mat3(instanceMatrix)*normal);
      vec3 ic=vec3(0.8);
      #ifdef USE_INSTANCING_COLOR
        ic=instanceColor;
      #endif
      vC=mix(aCol,ic,aBody); vT=aTint; gl_Position=projectionMatrix*viewMatrix*w; }`,
  fragmentShader:`uniform vec3 ink,L; uniform float sp,hatchOn; varying vec3 vN; varying vec3 vW; varying vec3 vC; varying float vT; ${NOISE} ${HATCH}
    void main(){ vec3 n=normalize(vN), a=abs(n); vec2 uv=a.y>max(a.x,a.z)?vW.xz:(a.x>a.z?vW.zy:vW.xy);
      float t=(0.22+0.78*max(dot(n,normalize(L)),0.0))*vT;
      float cov=max(hatch(uv,0.785,0.11,sp)*smoothstep(0.64,0.56,t)*0.75, hatch(uv,-0.785,0.11,sp)*smoothstep(0.44,0.36,t));
      vec3 col=vC*mix(0.8,1.0,smoothstep(0.2,0.9,t));
      gl_FragColor=vec4(mix(col,ink,cov*0.75*hatchOn),1.0); }`,
  extensions:{derivatives:true}});
const vehOutMat=new THREE.ShaderMaterial({
  uniforms:{c:{value:INK},w:U.w},
  vertexShader:`uniform float w;
    void main(){ gl_Position=projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(position+normalize(normal)*w*0.5,1.0); }`,
  fragmentShader:`uniform vec3 c; void main(){ gl_FragColor=vec4(c,1.0); }`, side:THREE.BackSide});

/* ================= Modelos (los de la lámina estilos/vehiculos.html) ================= */
const BODY=-1;   // pieza que toma el color de cada vehículo
const C={glass:0x9fb0ad, tire:0x4a3a2e, hub:0xcfc2a6, light:0xfbf3e1, rear:0xb8503c, gray:0xb9b2a3, dark:0x6a5a4c,
         red:0xc25a46, blue:0x7f9bb0, green:0x95a77c, ochre:0xd9b46a, white:0xf3ead6, black:0x5b4c40, silver:0xc9c3b4,
         yellow:0xe7c24f, teal:0x6f9c8c, cream:0xf1e3bf, wine:0xa9483a, lamp:0x86c070, charge:0x9cc28a};
function prof(pts,w,z){ const s=new THREE.Shape(); s.moveTo(pts[0][0],pts[0][1]); for(let i=1;i<pts.length;i++) s.lineTo(pts[i][0],pts[i][1]); s.closePath();
  const g=new THREE.ExtrudeGeometry(s,{depth:w,bevelEnabled:false}); g.translate(0,0,-w/2+(z||0)); return g; }
function bx(x0,x1,y0,y1,w,z){ return new THREE.BoxGeometry(x1-x0,y1-y0,w).translate((x0+x1)/2,(y0+y1)/2,z||0); }
function wheels(xs,r,tw,W){ const o=[];
  for(const x of xs) for(const s of [-1,1]){ const z=s*(W/2-tw/2+0.03);
    o.push([new THREE.CylinderGeometry(r,r,tw,8).rotateX(Math.PI/2).translate(x,r,z),C.tire,0.5]); }   // sin tapacubos: miles de coches, pocos triángulos
  return o; }
const both=f=>[f(-1),f(1)];
function lightsCar(xf,xr,yf,yr,W){ return [...both(s=>[bx(xf-0.03,xf+0.02,yf,yf+0.12,0.34,s*(W/2-0.3)),C.light,1]),
  ...both(s=>[bx(xr-0.02,xr+0.03,yr,yr+0.14,0.3,s*(W/2-0.28)),C.rear,0.9])]; }
function utilitario(col){ const W=1.74; return [
  [prof([[-2,.32],[2,.32],[2,.8],[1.7,.95],[-2,.95]],W),col], [prof([[-1.92,.95],[1.25,.95],[.35,1.45],[-1.72,1.45]],W-.1),C.glass,.55],
  [bx(-1.76,.42,1.45,1.52,W-.06),col], [bx(1.96,2.05,.3,.52,W-.08),C.gray],[bx(-2.05,-1.96,.3,.52,W-.08),C.gray],
  ...lightsCar(2.0,-2.0,.68,.72,W), ...wheels([1.28,-1.28],.32,.22,W)]; }
function berlina(col){ const W=1.8; return [
  [prof([[-2.35,.3],[2.35,.3],[2.35,.72],[2.0,.88],[-2.3,.9],[-2.35,.8]],W),col], [prof([[-1.55,.9],[1.05,.9],[.3,1.42],[-1.0,1.42]],W-.1),C.glass,.55],
  [bx(-1.02,.32,1.42,1.48,W-.1),col], [bx(2.3,2.4,.3,.5,W-.08),C.gray],[bx(-2.4,-2.3,.3,.5,W-.08),C.gray],
  ...lightsCar(2.35,-2.35,.6,.68,W), ...wheels([1.45,-1.45],.33,.22,W)]; }
function suv(col){ const W=1.9; return [
  [prof([[-2.3,.42],[2.3,.42],[2.3,1.0],[1.95,1.1],[-2.3,1.1]],W),col], [bx(-2.32,2.32,.3,.55,W+.02),C.dark,.7],
  [prof([[-2.2,1.1],[1.4,1.1],[.75,1.72],[-2.12,1.72]],W-.1),C.glass,.55], [bx(-2.14,.8,1.72,1.8,W-.08),col],
  ...both(s=>[bx(-1.9,.5,1.8,1.86,.06,s*.72),C.black,.7]), ...lightsCar(2.3,-2.3,.82,.85,W), ...wheels([1.4,-1.4],.4,.28,W)]; }
function taxi(){ const W=1.8; return [ ...berlina(C.black).slice(0,3), [bx(-1.25,1.0,.36,.89,W+.03),C.yellow],
  [bx(2.3,2.4,.3,.5,W-.08),C.gray],[bx(-2.4,-2.3,.3,.5,W-.08),C.gray], [bx(-.5,.1,1.48,1.66,.5),C.cream], [bx(-.25,-.1,1.66,1.76,.14),C.lamp,1.2],
  ...lightsCar(2.35,-2.35,.6,.68,W), ...wheels([1.45,-1.45],.33,.22,W)]; }
function furgoneta(col){ const W=2.0; return [
  [bx(-2.55,2.55,.35,1.1,W),col], [bx(-2.55,1.25,1.1,2.5,W),col], [bx(-2.4,1.1,1.45,1.75,W+.03),C.ochre],
  [prof([[1.25,1.1],[2.5,1.1],[1.85,2.05],[1.25,2.05]],W-.12),C.glass,.55], [bx(1.25,1.88,2.05,2.15,W-.06),col],
  [bx(2.5,2.6,.3,.55,W-.08),C.gray],[bx(-2.62,-2.55,.3,.55,W-.08),C.gray], ...lightsCar(2.55,-2.55,.85,.9,W), ...wheels([1.75,-1.75],.36,.25,W)]; }
function bodyBus(x0,x1,col,o){ o=Object.assign({W:2.55,belt:1.15,top:2.6,H:3.0,front:true,rear:true,doors:[]},o);
  const {W,belt,top,H}=o, P=[[bx(x0,x1,.35,belt,W),col],[bx(x0+(o.rear?.06:0),x1-(o.front?.06:0),belt,top,W-.08),C.glass,.55],[bx(x0,x1,top,H,W),col]];
  for(let x=x0+0.9;x<x1-0.9;x+=1.7) P.push([bx(x-.08,x+.08,belt,top,W-.03),col]);
  for(const xd of o.doors) P.push([bx(xd-.6,xd+.6,.42,top-.05,.04,W/2+.01),C.glass,.42]);
  if(o.front){ P.push([bx(x1-.02,x1+.02,top-.38,top-.06,W*.62),C.light,1.1],[bx(x1-.04,x1+.1,.3,.6,W-.1),C.gray],...both(s=>[bx(x1-.02,x1+.03,.7,.84,.4,s*(W/2-.35)),C.light,1])); }
  if(o.rear){ P.push([bx(x0-.1,x0+.04,.3,.6,W-.1),C.gray],...both(s=>[bx(x0-.03,x0+.02,.75,.95,.3,s*(W/2-.3)),C.rear,.9])); }
  return P; }
function estandar(){ return [...bodyBus(-6,6,C.red,{doors:[4.9,0.6,-3.6]}), [bx(-1.2,2.6,3.0,3.32,1.8),C.gray], ...wheels([3.7,-2.7],.5,.3,2.55)]; }
function articulado(){ const P=[...bodyBus(0.5,9,C.red,{rear:false,doors:[7.9,3.6]}), ...bodyBus(-9,-0.5,C.red,{front:false,doors:[-2.4]}), [bx(-1.0,1.8,3.0,3.3,1.8),C.gray]];
  for(let i=0;i<7;i++){ const x=-0.5+i*(1.0/6); P.push([bx(x-.05,x+.05,.45,2.95,2.4-(i%2)*.08),i%2?C.dark:C.black,.6]); }
  return [...P, ...wheels([7.4,1.6,-7.0],.5,.3,2.55)]; }
function barrio(){ const W=2.35; return [...bodyBus(-4,4,C.white,{W,belt:1.05,top:2.45,H:2.85,doors:[3.0,-0.6]}),
  [bx(-4,4,.9,1.05,W+.02),C.red], [bx(-4,4,2.6,2.85,W+.02),C.red], ...wheels([2.7,-2.5],.42,.26,W)]; }
function turistico(){ const W=2.55, P=[...bodyBus(-5.5,5.5,C.wine,{top:2.25,H:2.55,doors:[4.5,-0.3]}),
  [bx(-5.5,5.5,2.25,2.55,W+.02),C.cream], [bx(-5.5,5.5,2.55,2.7,W),C.wine], ...both(s=>[bx(-5.5,5.38,2.7,3.55,.12,s*(W/2-.06)),C.wine]),
  [bx(-5.5,-5.36,2.7,3.55,W),C.wine], [bx(5.36,5.5,2.7,3.85,W),C.glass,.55], [bx(2.3,5.5,3.85,3.95,W),C.wine], ...both(s=>[bx(2.3,2.42,3.55,3.85,.1,s*(W/2-.08)),C.wine])];
  for(let x=-4.8;x<4.8;x+=.85) for(const z of [-.62,.62]) P.push([bx(x-.22,x+.18,2.7,3.12,.85,z),C.cream,.85]);
  return [...P, ...wheels([3.6,-3.0],.5,.3,W)]; }
const NIT_BLUE=0x4f74a3;
function nitbus(){ return [...bodyBus(-6,6,NIT_BLUE,{doors:[4.9,0.6,-3.6]}), [bx(-6,6,1.15,1.26,2.57),0xe8c25a], [bx(-1.2,2.6,3.0,3.32,1.8),C.gray], ...wheels([3.7,-2.7],.5,.3,2.55)]; }
function electrico(){ const W=2.55; return [...bodyBus(-6,6,C.teal,{doors:[4.9,0.6,-3.6]}), [bx(-6,6,1.15,1.26,W+.02),C.charge],
  [bx(-4.6,-0.6,3.0,3.36,2.0),C.gray], [bx(0.9,2.3,3.0,3.14,1.3),C.black,.7],
  ...both(s=>[new THREE.BoxGeometry(1.5,.07,.07).rotateZ(.55).translate(1.3,3.5,s*.45),C.black,.7]),
  [new THREE.CylinderGeometry(.05,.05,1.6,8).rotateX(Math.PI/2).translate(1.95,3.88,0),C.dark,.7], ...wheels([3.7,-2.7],.5,.3,W)]; }

function mergeModel(parts){
  const geos=[];
  for(const [g0,hex,tint] of parts){
    const g=g0.index?g0.toNonIndexed():g0;
    for(const a of Object.keys(g.attributes)) if(a!=='position'&&a!=='normal') g.deleteAttribute(a);
    const n=g.attributes.position.count, col=new Float32Array(n*3), body=new Float32Array(n), ti=new Float32Array(n).fill(tint==null?1:tint);
    const c=new THREE.Color(hex===BODY?0xcccccc:hex);
    for(let i=0;i<n;i++){ col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b; body[i]=hex===BODY?1:0; }
    g.setAttribute('aCol',new THREE.BufferAttribute(col,3)); g.setAttribute('aBody',new THREE.BufferAttribute(body,1)); g.setAttribute('aTint',new THREE.BufferAttribute(ti,1));
    g.clearGroups(); geos.push(g);
  }
  const geo=THREE.BufferGeometryUtils.mergeBufferGeometries(geos);
  let hull=new THREE.BufferGeometry(); hull.setAttribute('position',geo.attributes.position.clone());
  hull=THREE.BufferGeometryUtils.mergeVertices(hull,1e-3); hull.computeVertexNormals();
  return {geo,hull};
}
const PAL=[C.red,C.blue,C.green,C.ochre,C.white,C.black,C.silver,C.silver,C.white,C.black];   // plata, blanco y negro algo más frecuentes
const CAR_MODELS=[
  {name:'utilitario',w:40,len:4.1,parts:()=>utilitario(BODY),pal:PAL},
  {name:'berlina',w:22,len:4.8,parts:()=>berlina(BODY),pal:PAL},
  {name:'SUV',w:18,len:4.7,parts:()=>suv(BODY),pal:PAL},
  {name:'taxi',w:12,lowCol:C.black,len:4.8,parts:taxi,pal:[C.black]},
  {name:'furgoneta',w:8,len:5.2,parts:()=>furgoneta(BODY),pal:[C.white,C.white,C.silver,C.ochre]}];
const BUS_MODELS=[
  {name:'estándar',w:45,lowCol:C.red,len:12.2,parts:estandar,maxCls:6},{name:'articulado',w:25,lowCol:C.red,len:18.3,parts:articulado,maxCls:3},
  {name:'de barrio',w:10,lowCol:C.white,len:8.2,parts:barrio,maxCls:7},{name:'eléctrico',w:15,lowCol:C.teal,len:12.2,parts:electrico,maxCls:6},{name:'turístico',w:5,lowCol:C.wine,len:11.2,parts:turistico,maxCls:3},
  {name:'NitBus',w:0,lowCol:NIT_BLUE,len:12.2,parts:nitbus,maxCls:6}];        // bus nocturno del AMB (solo con su horario, nunca simulado)

function instGeo(base,attrs){ const g=new THREE.InstancedBufferGeometry(); if(base.index) g.setIndex(base.index);
  for(const k in base.attributes) g.setAttribute(k,base.attributes[k]); for(const k in attrs) g.setAttribute(k,attrs[k]); g.instanceCount=0; return g; }
// modelo simplificado para cuando el coche ocupa pocos píxeles: carrocería + cristales, sin ruedas ni faros
function lowParts(m){ if(m.low) return m.low(); const L=m.len, W=m.bus?2.5:1.8, col=m.lowCol!=null?m.lowCol:BODY;
  if(m.bus){ const H=m.name==='turístico'?3.9:3.0; return [[bx(-L/2,L/2,.35,1.15,W),col],[bx(-L/2+.1,L/2-.1,1.15,H-.35,W-.06),C.glass,.55],[bx(-L/2,L/2,H-.35,H,W),col]]; }
  const H=m.name==='SUV'?1.8:m.name==='furgoneta'?2.45:1.5, belt=m.name==='furgoneta'?1.1:H*0.62;
  if(m.name==='furgoneta') return [[bx(-L/2,L/2,.3,belt,W),col],[bx(-L/2,L/2*0.5,belt,H,W),col],[bx(L/2*0.5,L/2-.3,belt,H-.4,W-.12),C.glass,.55]];
  return [[bx(-L/2,L/2,.3,belt,W),col],[bx(-L/2+L*.2,L/2-L*.32,belt,H,W-.12),C.glass,.55]]; }
function makeRenderer(model,cap){
  const hi=mergeModel(model.parts()), lo=mergeModel(lowParts(model));
  const mk=(g,mat)=>{ const im=new THREE.InstancedMesh(g,mat,cap); im.frustumCulled=false; im.count=0; return im; };
  const m=mk(hi.geo,vehMat), o=mk(hi.hull,vehOutMat), ml=mk(lo.geo,vehMat), ol=mk(lo.hull,vehOutMat);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const color=new THREE.InstancedBufferAttribute(new Float32Array(cap*3),3).setUsage(THREE.DynamicDrawUsage);
  for(const im of [o,ml,ol]) im.instanceMatrix=m.instanceMatrix;      // todas comparten posiciones
  m.instanceColor=ml.instanceColor=color;
  vehGroup.add(m,o,ml,ol);
  return {model,cap,hi:[m,o],lo:[ml,ol],mat:m.instanceMatrix,color,list:[]};
}
function setCount(r,k){ for(const im of r.hi.concat(r.lo)) im.count=k;
  r.mat.updateRange.offset=0; r.mat.updateRange.count=k*16; r.mat.needsUpdate=true;      // solo se sube lo usado
  r.color.updateRange.offset=0; r.color.updateRange.count=k*3; r.color.needsUpdate=true; }
// matriz de instancia (columnas): traslación · giro en Y · escala
function writePose(M,k,x,z,a,s,y){ const c=Math.cos(a)*s, n=Math.sin(a)*s, o=k*16;
  M[o]=c; M[o+1]=0; M[o+2]=-n; M[o+3]=0;  M[o+4]=0; M[o+5]=s; M[o+6]=0; M[o+7]=0;
  M[o+8]=n; M[o+9]=0; M[o+10]=c; M[o+11]=0;  M[o+12]=x; M[o+13]=y===undefined?Y0:y; M[o+14]=z; M[o+15]=1; }
let RC=null, RB=null, RP=null;   // coches y buses circulando, coches aparcados (se crean al acercarse por primera vez)
function ensureRenderers(){ if(RC) return; RC=CAR_MODELS.map(m=>makeRenderer(m,CAR_CAP)); RB=BUS_MODELS.map(m=>makeRenderer(m,BUS_CAP));
  RP=CAR_MODELS.filter(m=>m.name!=='taxi').map(m=>makeRenderer(m,PARK_CAP)); }

/* ================= Red viaria y simulación ================= */
// Modelo de seguimiento (IDM): cada vehículo acelera hacia su velocidad deseada y frena según la distancia
// al de delante, a un semáforo en rojo o a un cruce ocupado. Nunca avanza más que el hueco libre, así que no se
// atraviesan. Aparecen y desaparecen fuera de la vista (o se difuminan si no queda otra).
let RED=null, redState='none', TRAF=null;
const HOUR=[.25,.15,.1,.1,.12,.25,.6,.95,1,.85,.8,.82,.85,.85,.9,.9,.95,1,1,.9,.7,.55,.45,.35];   // curva diaria típica
const DENS=[.04,.04,.035,.03,.025,.015,.011,.005];       // vehículos por metro y carril (≈ uno cada 25–90 m por carril)
const TRAF_D=[1,.6,1,1.7,2.3,3,.15], TRAF_V=[1,1,.85,.55,.35,.15,.05];   // por estado del tramo (0 = sin datos)
const CYCLE=60, GREEN=27, AMBER=3;       // semáforos: dos fases por cruce (ejes que se cruzan)
const hash=(x,z)=>{ const s=Math.sin(x*12.9898+z*78.233)*43758.5453; return s-Math.floor(s); };
// cargas con reintento: un fallo pasajero (servidor arrancando, disco frío) ya no deja la capa vacía hasta recargar
const LOADERR={}, RETRIES={};
function retryLater(key,reset,e){ LOADERR[key]=String((e&&e.message)||e); console.warn('vivo: no se pudo cargar',key,e);
  const n=RETRIES[key]=(RETRIES[key]||0)+1; setTimeout(()=>{ reset(); K.dirty(); },Math.min(60000,1500*2**Math.min(n-1,6))); }
const okLoad=key=>{ delete LOADERR[key]; RETRIES[key]=0; };
async function loadRed(){
  redState='loading'; panel();
  try{ const r=await fetch(VIVO+'red.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status); RED=prepRed(await r.json()); redState='ready'; okLoad('red'); }
  catch(e){ redState='missing'; retryLater('red',()=>{ if(redState==='missing') redState='none'; },e); }
  panel(); K.dirty();
}
function prepRed(d){
  const N=d.nodos.length;
  const E=d.tramos.map(r=>{ const c=Float32Array.from(r[6]), n=c.length/2, cum=new Float32Array(n);
    for(let i=1;i<n;i++) cum[i]=cum[i-1]+Math.hypot(c[2*i]-c[2*i-2],c[2*i+1]-c[2*i-1]);
    const k=n>>1; return {a:r[0],b:r[1],cls:r[2],lanes:r[3],one:r[4],v:r[5]/3.6,c,cum,len:cum[n-1],t:r[7],mx:c[2*k],mz:c[2*k+1]}; });
  const out=Array.from({length:N},()=>[]), deg=new Uint8Array(N);
  E.forEach((e,i)=>{ out[e.a].push(i*2); if(!e.one) out[e.b].push(i*2+1); deg[e.a]++; deg[e.b]++; });
  const sig=new Uint8Array(N); for(const i of (d.senales||[])) sig[i]=1;
  const off=new Float32Array(N), ref=new Float32Array(N).fill(NaN);
  for(let i=0;i<N;i++) off[i]=hash(d.nodos[i][0],d.nodos[i][1])*CYCLE;
  const grp=(node,ang)=>{ if(isNaN(ref[node])) ref[node]=ang; let x=Math.abs(((ang-ref[node])%Math.PI+Math.PI)%Math.PI); x=Math.min(x,Math.PI-x); return x<Math.PI/4?0:1; };
  for(const e of E){ const c=e.c, n=c.length;
    e.g0=sig[e.b]?grp(e.b,Math.atan2(c[n-1]-c[n-3],c[n-2]-c[n-4])):-1;              // llegando a b
    e.g1=(!e.one&&sig[e.a])?grp(e.a,Math.atan2(c[1]-c[3],c[0]-c[2])):-1; }           // llegando a a (sentido contrario)
  const CELL=250, cells=new Map();
  E.forEach((e,i)=>{ const k=Math.floor(e.mx/CELL)+','+Math.floor(e.mz/CELL); let l=cells.get(k); if(!l) cells.set(k,l=[]); l.push(i); });
  // rejillas de nodos para quien no circula por el grafo (buses del GTFS, ciclistas): semáforos y cruces sin semáforo
  const NG=30, sgrid=new Map(), jgrid=new Map(), nx=new Float32Array(N), nz=new Float32Array(N);
  for(let i=0;i<N;i++){ nx[i]=d.nodos[i][0]; nz[i]=d.nodos[i][1]; const G=sig[i]?sgrid:deg[i]>=3?jgrid:null; if(!G) continue;
    const k=Math.floor(nx[i]/NG)*100003+Math.floor(nz[i]/NG); let l=G.get(k); if(!l) G.set(k,l=[]); l.push(i); }
  return {E,out,deg,sig,off,ref,nx,nz,sgrid,jgrid,NG,cells,CELL,nSig:(d.senales||[]).length};
}
// fase de un cruce para quien llega con rumbo 'ang' (= atan2(dz,dx)), con el mismo criterio que los tramos
function grpOf(node,ang){ const r=RED.ref[node]; if(isNaN(r)) return 0; let x=Math.abs(((ang-r)%Math.PI+Math.PI)%Math.PI); x=Math.min(x,Math.PI-x); return x<Math.PI/4?0:1; }
// nodo más cercano delante de (x,z) en la rejilla G, a menos de maxD y como mucho 'lat' m a un lado → [distancia, nodo]
function nodeAhead(G,x,z,ang,maxD,lat){ const dx=Math.cos(ang), dz=Math.sin(ang), NG=RED.NG; let best=-1, bl=maxD;
  const r=Math.ceil(maxD/NG), ix0=Math.floor(x/NG), iz0=Math.floor(z/NG);
  for(let ix=ix0-r;ix<=ix0+r;ix++) for(let iz=iz0-r;iz<=iz0+r;iz++){ const l=G.get(ix*100003+iz); if(!l) continue;
    for(const i of l){ const rx=RED.nx[i]-x, rz=RED.nz[i]-z, lon=rx*dx+rz*dz; if(lon<=0||lon>=bl||Math.abs(-rx*dz+rz*dx)>lat) continue; bl=lon; best=i; } }
  return best<0?null:[bl,best]; }
// ¿hay que parar antes del semáforo de delante? → distancia libre hasta la línea de detención, o -1 si se puede pasar
function stopForLight(x,z,ang,front,v,dec,look,lat){ if(!RED) return -1;
  const h=nodeAhead(RED.sgrid,x,z,ang,look,lat); if(!h) return -1;
  const gap=h[0]-front-STOPLINE; if(gap<-0.5) return -1;                       // ya está dentro del cruce: que salga
  const l=luz(h[1],grpOf(h[1],ang)); if(l===0) return -1;
  if(l===1&&gap<v*v/(2*dec)) return -1;                                         // en ámbar solo pasa si ya no puede frenar
  return Math.max(0,gap); }
const STOPLINE=4;
const estado=e=>(TRAF&&e.t>=0&&TRAF.get(e.t))||0;
const lanesDir=e=>e.one?e.lanes:Math.max(1,e.lanes>>1);
const hourF=()=>HOUR[horaBcn()];
const dens=e=>DENS[e.cls]*lanesDir(e)*TRAF_D[estado(e)]*hourF()*(e.one?1:2);
const speed=e=>e.v*TRAF_V[estado(e)];
function luz(node,g){ const t=(performance.now()/1000+RED.off[node])%CYCLE, ph=g?(t+CYCLE/2)%CYCLE:t; return ph<GREEN?0:ph<GREEN+AMBER?1:2; }   // 0 verde, 1 ámbar, 2 rojo

let area={x:0,z:0,r:0}, cand=[], cum=new Float64Array(0), candTot=0, candDirty=true, busCand=[], busCum=new Float64Array(0);
function updateArea(){
  const t=K.controls.target, cam=K.cam, hh=(cam.top-cam.bottom)/cam.zoom/2, hw=(cam.right-cam.left)/cam.zoom/2;
  // la vista está inclinada: en vertical se ve más suelo que alto tiene la pantalla
  const stretch=1/Math.max(0.35,Math.cos(K.controls.getPolarAngle?K.controls.getPolarAngle():0.9));
  let r=Math.min(1600,Math.max(220,Math.max(hh*stretch,hw)*1.15));
  if(!candDirty&&!parkDirty&&area.r&&Math.hypot(t.x-area.x,t.z-area.z)<r*0.2&&Math.abs(r-area.r)<area.r*0.25) return false;
  if(area.r&&Math.hypot(t.x-area.x,t.z-area.z)>area.r){ firstFill=true; saltoHasta=performance.now()+3000; }   // salto lejos: llenar de golpe
  candDirty=false;
  const {E,cells,CELL}=RED;
  const juntar=r=>{ cand=[]; for(let ix=Math.floor((t.x-r)/CELL);ix<=Math.floor((t.x+r)/CELL);ix++) for(let iz=Math.floor((t.z-r)/CELL);iz<=Math.floor((t.z+r)/CELL);iz++){
      const l=cells.get(ix+','+iz); if(l) for(const i of l) cand.push(i); }
    let s=0; for(const i of cand) s+=E[i].len*dens(E[i]); return s; };
  // de lejos caben más coches de los que se dibujan (tope MOVE_CAP): se encoge el círculo hacia lo que se ve
  // para que no se repartan por fuera de la pantalla (como mucho hasta el ancho visible)
  let s=juntar(r);
  if(s>MOVE_CAP*1.2){ const r2=Math.max(Math.min(r,hw*1.05),r*Math.sqrt(MOVE_CAP*1.2/s)); if(r2<r*0.95){ r=r2; s=juntar(r); } }
  area={x:t.x,z:t.z,r}; busCand=[];
  cum=new Float64Array(cand.length); s=0; cand.forEach((i,k)=>{ s+=E[i].len*dens(E[i]); cum[k]=s; }); candTot=s;
  for(const i of cand) if(E[i].cls<=4) busCand.push(i);
  busCum=new Float64Array(busCand.length); let sb=0; busCand.forEach((i,k)=>{ sb+=E[i].len*(E[i].cls<=3?1:.4); busCum[k]=sb; });
  return true;
}
function pick(list,cw){ const x=Math.random()*cw[cw.length-1]; let lo=0,hi=cw.length-1; while(lo<hi){ const m=(lo+hi)>>1; if(cw[m]<x) lo=m+1; else hi=m; } return list[lo]; }
const inArea=(e,f)=>Math.hypot(e.mx-area.x,e.mz-area.z)<area.r*(f||1.15);
const _p=new THREE.Vector3();
const offScreen=(x,z)=>{ _p.set(x,Y0,z).project(K.cam); return Math.abs(_p.x)>1.08||Math.abs(_p.y)>1.08; };
function wpick(arr){ let s=0; for(const m of arr) s+=m.model.w; let x=Math.random()*s; for(const m of arr){ x-=m.model.w; if(x<=0) return m; } return arr[0]; }
function chooseNext(v){
  const E=RED.E, e=E[v.e], end=v.dir?e.a:e.b, opts=RED.out[end], rev=v.e*2+(v.dir?0:1);
  let ok=opts.filter(p=>p!==rev&&(!v.bus||E[p>>1].cls<=5));
  if(INC_CERRADA.size&&ok.length>1){ const abiertas=ok.filter(p=>!INC_CERRADA.has(p>>1)); if(abiertas.length) ok=abiertas; }   // calle cortada: se desvían
  if(ok.length) return ok[(Math.random()*ok.length)|0];
  return opts.includes(rev)?rev:-1;          // calle sin salida: media vuelta si es de doble sentido
}
// coloca el vehículo en un tramo libre, a ser posible fuera de la vista
function spawn(v,anywhere){
  const E=RED.E; const list=v.bus?busCand:cand, cw=v.bus?busCum:cum; if(!list.length||cw[cw.length-1]<=0) return false;
  for(let t=0;t<14;t++){
    const ei=pick(list,cw), e=E[ei], dir=(e.one||Math.random()<0.5)?0:1, s=Math.random()*e.len;
    const u=dir?e.len-s:s, i=Math.min(e.cum.length-2,Math.max(0,e.cum.findIndex(c=>c>u)-1));
    if(!anywhere&&t<12&&!offScreen(e.c[2*i],e.c[2*i+1])) continue;
    if(TRAM&&tramCerca(e.c[2*i],e.c[2*i+1],3)) continue;                    // nunca aparece encima de la vía del tranvía
    const lane=Math.floor(Math.random()*lanesDir(e)), l=lanesMap.get((ei*2+dir)*8+lane);
    if(INC_OBS.size&&incDentro(ei,dir,lane,s)) continue;                    // ni dentro ni justo al lado de una incidencia
    if(l&&l.some(o=>Math.abs(o.s-s)<(o.len+v.len)/2+4)) continue;
    Object.assign(v,{e:ei,dir,s,lane,age:0,fade:-1,wait:0,ahead:null});
    v.v=speed(e)*v.k*0.7; v.next=chooseNext(v);
    if(l) l.push(v); else lanesMap.set((ei*2+dir)*8+lane,[v]);
    return true;
  }
  return false;
}
function newVehicle(bus,anywhere){
  const pool=bus?RB:RC; let r=wpick(pool);
  const v={bus,k:0.85+Math.random()*0.3}; v.len=r.model.len;
  if(!spawn(v,anywhere)) return null;
  if(bus){ let g=0; while(RED.E[v.e].cls>r.model.maxCls&&g++<6) r=wpick(pool); v.len=r.model.len; }
  if(r.list.length>=r.cap) return null;
  const c=new THREE.Color(r.model.pal?r.model.pal[(Math.random()*r.model.pal.length)|0]:0xffffff);
  v.col=[c.r,c.g,c.b]; r.list.push(v); return v;
}
let lastSync=0, nCars=0, nBuses=0, nParked=0, nStopped=0, firstFill=true;
/* ---- Coches aparcados: en las plazas que dibuja suelo.py (las pasa index.html al cargar cada bloque) ---- */
const PARK=K.plazas||(K.plazas=new Map()); let parkDirty=PARK.size>0;   // index.html guarda aquí las plazas aunque vivo.js cargue después
K.onSuelo=(file,arr)=>{ if(arr&&arr.length){ PARK.set(file,arr); parkDirty=true; } };
const bboxOf=new WeakMap();
function bbox(arr){ let b=bboxOf.get(arr); if(b) return b; b=[1e9,1e9,-1e9,-1e9];
  for(let i=0;i+3<arr.length;i+=4){ const x=arr[i],z=arr[i+1]; if(x<b[0])b[0]=x; if(z<b[1])b[1]=z; if(x>b[2])b[2]=x; if(z>b[3])b[3]=z; }
  bboxOf.set(arr,b); return b; }
function refreshParked(){
  parkDirty=false;
  for(const r of RP) r.list=[];
  const tot=RP.reduce((s,r)=>s+r.model.w,0), R=area.r*1.1;
  for(const arr of PARK.values()){
    const b=bbox(arr); if(b[2]<area.x-R||b[0]>area.x+R||b[3]<area.z-R||b[1]>area.z+R) continue;   // bloque lejos: ni se mira
    for(let i=0;i+3<arr.length;i+=4){
      const x=arr[i], z=arr[i+1]; if(Math.abs(x-area.x)>R||Math.abs(z-area.z)>R) continue;
      const h=hash(x,z); if(h>0.9) continue;                         // ~90 % de plazas ocupadas (sin dato de ocupación todavía)
      const h2=hash(z+3.1,x-7.7); let w=h2*tot, r=RP[0]; for(const m of RP){ w-=m.model.w; if(w<=0){ r=m; break; } }
      if(r.list.length>=r.cap) continue;
      const pal=r.model.pal, c=new THREE.Color(pal[Math.floor(hash(x+1.7,z-2.3)*pal.length)%pal.length]);
      let ang=arr[i+2]; const o=arr[i+3];
      if(o>=2) ang+=h2<0.5?Math.PI/2:-Math.PI/2; else if(o===1) ang+=0.55; else if(h<0.45) ang+=Math.PI;
      r.list.push([x,z,ang,c.r,c.g,c.b]);
    }
  }
  nParked=0;
  for(const r of RP){ const M=r.mat.array, Cc=r.color.array; r.list.forEach((p,k)=>{ writePose(M,k,p[0],p[1],p[2],1); Cc[k*3]=p[3]; Cc[k*3+1]=p[4]; Cc[k*3+2]=p[5]; });
    setCount(r,r.list.length); nParked+=r.list.length; }
}
function sync(now){
  if(now-lastSync<500) return; lastSync=now;
  if(updateArea()) refreshParked();
  const want=Math.min(MOVE_CAP,Math.round(candTot)), wantB=Math.min(BUS_CAP,Math.round(candTot*0.035));
  const moving=r=>r.list.reduce((s,v)=>s+(v.remove?0:1),0);
  const adjust=(pool,target)=>{ let n=pool.reduce((s,r)=>s+moving(r),0);
    const fill=firstFill||n<target*0.7;                 // faltan muchos: se colocan también a la vista (aparecen con un fundido)
    let budget=fill?250:50;
    while(n<target&&budget-->0){ if(!newVehicle(pool===RB,fill)) break; n++; }
    // sobran: se retiran difuminándose (los que estén fuera de la vista primero)
    for(const r of pool) for(const v of r.list){ if(n<=target) break; if(!v.remove&&v.fade<0){ v.remove=true; v.fade=0.6; n--; } } };
  adjust(RC,want); if(!BUS) adjust(RB,wantB); firstFill=false;
}
const lanesMap=new Map(), busy=new Map(), PB=new Float32Array(4);
const GC=16, gkey=(x,z)=>Math.floor(x/GC)*100003+Math.floor(z/GC);
let carGrid=new Map(), busGrid=new Map();
// las rejillas se reutilizan entre fotogramas (vaciar en vez de crear): menos basura para el recolector
function gridReset(G){ if(G.size>4000) G.clear(); else for(const l of G.values()) l.length=0; }
function gridPut(G,o){ const k=gkey(o.x,o.z); let l=G.get(k); if(!l) G.set(k,l=[]); l.push(o); }
// obstáculo más cercano delante de (x,z) con rumbo 'ang', en el mismo carril (±1,7 m) y sentido parecido
function aheadIn(G,x,z,ang,maxD,self){ const dx=Math.cos(ang), dz=-Math.sin(ang); let best=null, bl=maxD;
  const cx=x+dx*maxD/2, cz=z+dz*maxD/2, r=Math.ceil(maxD/2/GC)+1, ix0=Math.floor(cx/GC), iz0=Math.floor(cz/GC);
  for(let ix=ix0-r;ix<=ix0+r;ix++) for(let iz=iz0-r;iz<=iz0+r;iz++){ const l=G.get(ix*100003+iz); if(!l) continue;
    for(const o of l){ if(o===self) continue; const rx=o.x-x, rz=o.z-z, lon=rx*dx+rz*dz; if(lon<=0||lon>=bl) continue;
      if(Math.abs(-rx*dz+rz*dx)>1.7||Math.cos(o.ang-ang)<0.75) continue; bl=lon; best=o; } }
  return best?[bl,best]:null; }
const A_CAR=1.6, A_BUS=1.0, B_DEC=2.2, S0=2.0, T_HW=1.2;
// justo después de saltar lejos, los que venían de la zona anterior se recolocan también a la vista (con fundido)
let saltoHasta=0;
function respawn(v){ if(v.remove){ v.dead=true; return; } if(!spawn(v,performance.now()<saltoHasta)) v.dead=true; }
function drive(v,dt){
  const E=RED.E; let e=E[v.e];
  v.age+=dt;
  if(v.fade>=0){ v.fade-=dt; if(v.fade<=0) respawn(v); return; }
  const v0=Math.max(0.3,speed(e)*v.k*(v.bus?0.85:1)), L=v.len;
  const rem=e.len-v.s, end=v.dir?e.a:e.b;
  let gap=1e9, dv=0, blocked=false;
  if(v.ahead){ gap=v.ahead.s-v.s-(v.ahead.len+L)/2; dv=v.v-v.ahead.v; }
  else{
    const g=v.dir?e.g1:e.g0;
    if(g>=0){ const l=luz(end,g); if(l===2||(l===1&&rem>v.v*v.v/(2*B_DEC)+L/2+2)){ gap=rem-L/2-3; dv=v.v; blocked=true; } }   // en ámbar solo pasa si ya no puede frenar
    else if(RED.deg[end]>=3&&v.wait<5){ const o=busy.get(end); if(o&&o!==v&&rem<14){ gap=rem-L/2-3; dv=v.v; blocked=true; } }        // cruce sin semáforo ocupado: espera
    if(!blocked){
      if(v.next<0){ gap=rem-L/2-1; dv=v.v; }
      else{ const ne=E[v.next>>1], ln=Math.min(v.lane,lanesDir(ne)-1), l2=lanesMap.get(v.next*8+ln);
        if(l2&&l2.length){ let f=l2[0]; for(const o of l2) if(o.s<f.s) f=o; gap=Math.min(gap,rem+f.s-(f.len+L)/2); dv=v.v-f.v; } }
    }
  }
  if(v.px!==undefined&&busGrid.size){ const h=aheadIn(busGrid,v.px,v.pz,v.ang,35,null);
    if(h){ const g=h[0]-(h[1].len+L)/2; if(g<gap){ gap=g; dv=v.v-h[1].v; } } }
  if(v.px!==undefined&&TRAM){ const g=tramParar(v.px,v.pz,Math.cos(v.ang),-Math.sin(v.ang),Math.max(25,v.v*v.v/(2*B_DEC)+L+12),L,gap);   // tranvía: prioridad
    if(g>=0&&g<gap){ gap=g; dv=v.v; if(g<8) nTramWait++; } }
  if(INC_OBS.size){ const g=incGap(v,L,rem); if(g<gap){ gap=g; dv=v.v; } }            // incidencia: cola detrás, sin atravesarla
  const a=v.bus?A_BUS:A_CAR, ss=S0+Math.max(0,v.v*T_HW+v.v*dv/(2*Math.sqrt(a*B_DEC)));
  let acc=a*(1-Math.pow(v.v/v0,4)-(gap<1e8?(ss/Math.max(gap,0.05))**2:0));
  v.v=Math.max(0,v.v+Math.max(acc,-9)*dt);
  let ds=v.v*dt; if(gap<1e8) ds=Math.min(ds,Math.max(0,gap-0.2));    // nunca más que el hueco libre: no se atraviesan
  if(ds<v.v*dt) v.v=ds/dt;
  v.s+=ds;
  v.wait=v.v<0.2?v.wait+dt:0;
  if(v.wait>(v.next<0?3:90)){ v.fade=0.6; return; }                   // sin salida o atasco eterno: se retira
  while(v.s>e.len&&v.next>=0){
    v.s-=e.len; const nx=v.next; v.e=nx>>1; v.dir=nx&1; e=E[v.e]; v.lane=Math.min(v.lane,lanesDir(e)-1); v.next=chooseNext(v);
  }
  if(v.s>e.len) v.s=e.len;
  if(!inArea(e,1.4)) respawn(v);                                        // ya salió de la vista: vuelve a entrar por otro sitio
}
function place(v,out,o){
  const e=RED.E[v.e], c=e.c, cu=e.cum, n=cu.length; const u=v.dir?e.len-v.s:v.s; let i=0;
  while(i<n-2&&cu[i+1]<u) i++;
  const L=(cu[i+1]-cu[i])||1, f=Math.min(1,Math.max(0,(u-cu[i])/L));
  let dx=(c[2*i+2]-c[2*i])/L, dz=(c[2*i+3]-c[2*i+1])/L; let x=c[2*i]+dx*L*f, z=c[2*i+1]+dz*L*f;
  if(v.dir){ dx=-dx; dz=-dz; }
  const ln=lanesDir(e), off=e.one?(v.lane-(ln-1)/2)*3.1:1.65+v.lane*3.1;
  out[o]=x-dz*off; out[o+1]=z+dx*off; out[o+2]=Math.atan2(-dz,dx);
  out[o+3]=v.fade>=0?Math.max(0,v.fade/0.6):Math.min(1,v.age/0.6);
}
function step(dt){
  const all=BUS?RC:RC.concat(RB);
  // 1) carriles ordenados y cruces ocupados
  lanesMap.clear(); busy.clear(); for(const [k,o] of busBusy) busy.set(k,o);
  for(const r of all) for(const v of r.list){ if(v.dead) continue;
    const k=(v.e*2+v.dir)*8+v.lane; let l=lanesMap.get(k); if(!l) lanesMap.set(k,l=[]); l.push(v);
    const e=RED.E[v.e];
    if(v.v>0.5){ if(e.len-v.s<4) busy.set(v.dir?e.a:e.b,v);           // entrando en el cruce (solo si se mueve:
                 else if(v.s<5) busy.set(v.dir?e.b:e.a,v); } }          //  un coche parado en cola no bloquea el cruce)
  for(const l of lanesMap.values()){ l.sort((a,b)=>a.s-b.s); for(let i=0;i<l.length;i++) l[i].ahead=l[i+1]||null; }
  // 2) mover
  for(const r of all) for(const v of r.list) if(!v.dead) drive(v,dt);
  // 3) escribir los buffers de instancias
  nCars=0; if(!BUS) nBuses=0; nStopped=0; gridReset(carGrid);
  for(const r of all){
    if(r.list.some(v=>v.dead)) r.list=r.list.filter(v=>!v.dead);
    const M=r.mat.array, Cc=r.color.array; let k=0;
    for(const v of r.list){
      place(v,PB,0); writePose(M,k,PB[0],PB[1],PB[2],PB[3]*VSC); if(v.bus) nBuses++; else nCars++; if(v.v<0.3) nStopped++;
      v.px=v.x=PB[0]; v.pz=v.z=PB[1]; v.ang=PB[2]; gridPut(carGrid,v);
      Cc[k*3]=v.col[0]; Cc[k*3+1]=v.col[1]; Cc[k*3+2]=v.col[2]; k++; }
    setCount(r,k);
  }
}

/* ================= Autobuses de TMB: horario real (GTFS) sobre su recorrido ================= */
// Cada expedición se mueve por su recorrido según las horas de paso de su patrón; para unos segundos en cada parada.
// Cuando llegue el retraso real (iBus) bastará con sumarlo a 'salida'.
let busBusy=new Map(), nBusLight=0, nBusJunc=0, nCycLight=0;
let BUS=null, busState='none', busActive=[], busLastScan=0, nBusAll=0, BUSDELAY=null, BUSDELAY_INFO=null;
const MAXD=900;   // retraso máximo que se aplica (±15 min)
const delayOf=name=>{ const d=BUSDELAY&&BUSDELAY[name]; return d?Math.max(-MAXD,Math.min(MAXD,d.retraso_s)):0; };
// Hora de Barcelona, sea cual sea el reloj del visitante (horarios de bus y metro, curva del tráfico, gente en la calle).
// madridDate() devuelve una fecha cuyos campos UTC son la hora de Barcelona; la diferencia se recalcula cada minuto.
const FMT_MAD=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
let madOff=0, madOffT=-1e12;
function madridDate(ms){ const n=Date.now(); if(n-madOffT>60000){ const o={}; for(const p of FMT_MAD.formatToParts(n)) o[p.type]=p.value;
    madOff=Date.UTC(+o.year,+o.month-1,+o.day,+o.hour,+o.minute,+o.second)-Math.floor(n/1000)*1000; madOffT=n; }
  return new Date((ms===undefined?n:ms)+madOff); }
const horaBcn=()=>madridDate().getUTCHours();
const ymd=d=>d.getUTCFullYear()+String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0');
async function loadBuses(){
  busState='loading';
  try{ const r=await fetch(VIVO+'buses.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status); BUS=prepBuses(await r.json()); busState='ready'; okLoad('bus'); IBX=null; progCache.clear();
       if(RB) for(const r of RB) r.list=[]; }                                // fuera los buses simulados
  catch(e){ busState='missing'; retryLater('bus',()=>{ if(busState==='missing') busState='none'; },e); }
  panel(); K.dirty();
}
function prepBuses(d){
  const shapes=d.recorridos.map(c=>{ const a=Float32Array.from(c), n=a.length/2, cu=new Float32Array(n);
    for(let i=1;i<n;i++) cu[i]=cu[i-1]+Math.hypot(a[2*i]-a[2*i-2],a[2*i+1]-a[2*i-1]); return {c:a,cum:cu}; });
  const now=madridDate(), hoy=ymd(now), ayer=ymd(new Date(now.getTime()-864e5));
  const sHoy=d.servicios.map(s=>s.includes(hoy)), sAyer=d.servicios.map(s=>s.includes(ayer));
  const trips=[]; let maxDur=0;
  d.viajes.forEach(([p,st,du,sv],i)=>{ if(sHoy[sv]) trips.push({p,st,du,i}); if(sAyer[sv]&&st+du>86400) trips.push({p,st:st-86400,du,i});
    if(du>maxDur) maxDur=du; });
  trips.sort((a,b)=>a.st-b.st);
  const modelOf=(name,i)=>{ const h=hash(i*0.37,i*1.13);                   // índice en BUS_MODELS
    if(/^N\d/.test(name)) return 5;                                            // NitBus (AMB)
    if(h<0.15) return 3;                                                       // eléctrico
    if(/^[HVD]/.test(name)) return h<0.65?1:0;                               // Nova Xarxa: muchos articulados
    if(/^1\d\d$/.test(name)) return 2;                                        // bus de barrio
    return 0; };
  return {d,shapes,trips,maxDur,hoy,modelOf,starts:Float64Array.from(trips.map(t=>t.st))};
}
const secNow=()=>{ const n=madridDate(); return n.getUTCHours()*3600+n.getUTCMinutes()*60+n.getUTCSeconds()+n.getUTCMilliseconds()/1000; };
function busPos(tr,t,out,S){
  S=S||BUS; const P=S.d.patrones[tr.p], sh=S.shapes[P[1]], dist=P[4], rel=P[5], OFF=S.off===undefined?1.8:S.off;
  const tau=(t-tr.st)/tr.du; let k=0; while(k<rel.length-2&&rel[k+1]<=tau) k++;
  const tk=tr.st+rel[k]*tr.du, T=Math.max(1,(rel[k+1]-rel[k])*tr.du), dwell=Math.min(S.dwell||15,T*0.3);
  let f=(t-tk-dwell)/Math.max(1,T-dwell); f=f<0?0:f>1?1:f; f=f*f*(3-2*f);                 // sale y frena suave
  const dd=dist[k]+(dist[k+1]-dist[k])*f, c=sh.c, cu=sh.cum, n=cu.length; tr.dd=dd;
  let lo=0,hi=n-2; while(lo<hi){ const m=(lo+hi+1)>>1; if(cu[m]<=dd) lo=m; else hi=m-1; }
  const L=(cu[lo+1]-cu[lo])||1, u=Math.min(1,Math.max(0,(dd-cu[lo])/L));
  const dx=(c[2*lo+2]-c[2*lo])/L, dz=(c[2*lo+3]-c[2*lo+1])/L;
  out[0]=c[2*lo]+dx*L*u-dz*OFF; out[1]=c[2*lo+1]+dz*L*u+dx*OFF; out[2]=Math.atan2(-dz,dx);
  out[3]=Math.min(1,(t-tr.st)/4,(tr.st+tr.du-t)/4);                                       // aparece y se va en la cabecera
}
const busLbl=[]; const busLblBox=document.createElement('div'); busLblBox.style.cssText='position:fixed;inset:0;pointer-events:none'; (document.getElementById('c')||document.body.firstChild).after(busLblBox);   // justo encima del mapa, debajo de los paneles
function busStep(now,dt){
  const t=secNow(); const BG=busGrid, BB=busBusy; gridReset(BG); BB.clear(); nBusLight=nBusJunc=0;
  if(now-busLastScan>1000){                                                    // expediciones en marcha (cada segundo)
    busLastScan=now; busActive=[];
    const S=BUS.starts; let lo=0,hi=S.length; const from=t-BUS.maxDur; while(lo<hi){ const m=(lo+hi)>>1; if(S[m]<from) lo=m+1; else hi=m; }
    lo=0; hi=S.length; const from2=t-BUS.maxDur-MAXD; while(lo<hi){ const m=(lo+hi)>>1; if(S[m]<from2) lo=m+1; else hi=m; }
    for(let i=lo;i<S.length&&S[i]<=t+MAXD;i++){ const tr=BUS.trips[i];
      const te=t-delayOf(BUS.d.lineas[BUS.d.patrones[tr.p][0]][0]); if(tr.st<=te&&tr.st+tr.du>=te) busActive.push(tr); }   // con su retraso real
    nBusAll=busActive.length;
  }
  for(const r of RB) r.n=0;
  const out=PB, R2=(area.r*1.2)**2, shown=[];
  for(const tr of busActive){
    const P=BUS.d.patrones[tr.p], line=BUS.d.lineas[P[0]], r=RB[BUS.modelOf(line[0],tr.i)];
    let te=t-delayOf(line[0])-(tr.hold||0);
    if(te<tr.st||te>tr.st+tr.du) continue;
    busPos(tr,te,out); if((out[0]-area.x)**2+(out[1]-area.z)**2>R2){ tr.hold=0; tr.px=undefined; continue; }
    const blk=aheadIn(carGrid,out[0],out[1],out[2],r.model.len,null);          // coche justo delante: el bus espera
    let stop=blk&&blk[0]<r.model.len/2+blk[1].len/2+2.5;
    if(!stop&&tr.px!==undefined&&RED){ const da=-tr.pa, adv=(out[0]-tr.px)*Math.cos(da)+(out[1]-tr.pz)*Math.sin(da), half=r.model.len/2;
      const g=stopForLight(tr.px,tr.pz,da,half,tr.sp||0,1.6,half+40,7);           // semáforo en rojo delante
      if(g>=0&&adv>g){ stop=true; nBusLight++; }
      if(!stop&&TRAM){ const L=r.model.len, gt=tramParar(tr.px,tr.pz,Math.cos(da),Math.sin(da),half+40,L,blk?blk[0]-blk[1].len/2-half:undefined);   // tranvía: prioridad
        if(gt>=0&&adv>gt){ stop=true; nTramWait++; } }
      if(!stop&&INCS.length){ const gi=incBus(tr.px,tr.pz,da,half); if(gi>=0&&adv>gi) stop=true; }        // incidencia en su carril: espera
      if(!stop){ const j=nodeAhead(RED.jgrid,tr.px,tr.pz,da,half+12,6);         // cruce sin semáforo ocupado por un coche
        if(j){ const o=busy.get(j[1]); if(o&&o!==tr&&!o.trip&&(tr.jw||0)<5&&adv>j[0]-half-STOPLINE){ stop=true; nBusJunc++; tr.jw=(tr.jw||0)+dt; } else if(!o) tr.jw=0; } } }
    if(stop){ tr.hold=Math.min(300,(tr.hold||0)+dt); if(tr.px!==undefined){ out[0]=tr.px; out[1]=tr.pz; out[2]=tr.pa; } }
    else if(tr.hold) tr.hold=Math.max(0,tr.hold-dt*0.25);                     // y luego recupera el horario poco a poco
    const sp=tr.px===undefined?0:Math.hypot(out[0]-tr.px,out[1]-tr.pz)/Math.max(dt,1e-3);
    tr.px=out[0]; tr.pz=out[1]; tr.pa=out[2]; tr.sp=tr.sp===undefined?sp:tr.sp*0.8+sp*0.2; tr.trip=true;
    if(RED&&sp>0.5){ const j=nodeAhead(RED.jgrid,out[0]-Math.cos(-out[2])*r.model.len/2,out[1]-Math.sin(-out[2])*r.model.len/2,-out[2],r.model.len+4,6);   // el bus ocupa el cruce que pisa
      if(j) BB.set(j[1],tr); }
    tr.x=out[0]; tr.z=out[1]; tr.ang=out[2]; tr.len=r.model.len; tr.v=sp; gridPut(BG,tr);
    if(r.n>=r.cap) continue;
    writePose(r.mat.array,r.n,out[0],out[1],out[2],out[3]*VSC);
    const c=r.color.array; c[r.n*3]=c[r.n*3+1]=c[r.n*3+2]=1; r.n++;
    if(shown.length<40) shown.push([out[0],out[1],line,delayOf(line[0])]);
  }
  nBuses=0; for(const r of RB){ setCount(r,r.n); nBuses+=r.n; }
  // etiquetas con el número de línea (solo de cerca)
  const mpp=K.mppNow(); let used=0;
  if(mpp<0.45) for(const [x,z,line,dl] of shown){
    _p.set(x,5,z).project(K.cam); if(Math.abs(_p.x)>1||Math.abs(_p.y)>1) continue;
    let el=busLbl[used]; if(!el){ el=document.createElement('span'); el.style.cssText='position:absolute;transform:translate(-50%,-100%);font:600 11px/1.2 "EB Garamond",serif;color:#fff;padding:0 4px;border-radius:2px;white-space:nowrap;box-shadow:0 0 0 1px rgba(58,38,22,.5)'; busLblBox.appendChild(el); busLbl.push(el); }
    el.textContent=line[0]+(Math.abs(dl)>=60?(dl>0?' +':' −')+Math.round(Math.abs(dl)/60)+'′':''); el.style.background=line[1]; el.style.left=((_p.x+1)/2*innerWidth)+'px'; el.style.top=((1-_p.y)/2*innerHeight)+'px'; el.style.display='block'; used++; }
  for(let i=used;i<busLbl.length;i++) busLbl[i].style.display='none';
}
function hideBusLabels(){ for(const el of busLbl) el.style.display='none'; }

/* ================= Metro: trenes según el horario real (GTFS de TMB) ================= */
let MET=null, metState='none', metActive=[], metLastScan=0, nMetroAll=0;
async function loadMetro(){
  metState='loading';
  try{ const r=await fetch(VIVO+'metro_horario.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status);
    MET=prepBuses(await r.json()); MET.off=5; MET.dwell=22;                    // vía de cada sentido separada; ~20 s en andén
    const depth={}; for(const l of ((K.metro&&K.metro.lines)||[])) depth[l.name]=l.depth_m;
    MET.depth=MET.d.lineas.map(l=>depth[l[0]]??depth[l[0].replace(/[NS]$/,'')]??25);
    MET.mesh=MET.d.lineas.map(l=>{ const m=new THREE.InstancedMesh(new THREE.BoxGeometry(80,14,14),new THREE.MeshBasicMaterial({color:new THREE.Color(l[1])}),60);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count=0; m.frustumCulled=false; K.metroGroup.add(m); return m; });
    for(const t of (K.trainSets||[])) t.inst.visible=false;                       // fuera los trenes simulados
    K.metroLive=true; metState='ready';
    if(K.renderLegend) K.renderLegend();
  }catch(e){ metState='missing'; retryLater('metro',()=>{ if(metState==='missing') metState='none'; },e); }
  panel(); K.dirty();
}
function metroStep(now){
  const t=secNow();
  if(now-metLastScan>1000){ metLastScan=now; metActive=[];
    const S=MET.starts; let lo=0,hi=S.length; const from=t-MET.maxDur; while(lo<hi){ const m=(lo+hi)>>1; if(S[m]<from) lo=m+1; else hi=m; }
    for(let i=lo;i<S.length&&S[i]<=t;i++){ const tr=MET.trips[i]; if(tr.st+tr.du>=t) metActive.push(tr); }
    nMetroAll=metActive.length; }
  const n=MET.mesh.map(()=>0);
  for(const tr of metActive){ const li=MET.d.patrones[tr.p][0], m=MET.mesh[li]; if(n[li]>=60) continue;
    busPos(tr,t,PB,MET); writePose(m.instanceMatrix.array,n[li],PB[0],PB[1],PB[2],Math.max(0.05,PB[3]),-MET.depth[li]); n[li]++; }
  MET.mesh.forEach((m,i)=>{ m.count=n[i]; m.instanceMatrix.needsUpdate=true; });
}

/* ================= Tranvía (TRAM: Trambaix T1–T3 y Trambesòs T4–T6): horario oficial (GTFS) sobre sus vías ================= */
// Va por la calle, así que tiene prioridad: cuando un tranvía está a menos de ~60 m de un punto donde su vía corta el paso
// de otros (calles, carril bici, pasos de peatones), ese punto queda reservado y coches, buses, bicis y personas esperan
// antes de la PRIMERA vía (nunca entre las dos). Un coche tampoco entra en las vías si la cola no le deja salir del otro lado.
const TRAM_LEN=32.5, TRAM_OFF=1.7, TRAM_ANTES=60, TRAM_DESPUES=4, TRAM_GRUPO=8;
const TRAM_GREEN=0x4f9a5c;
function tranviaParts(){ const W=2.65, P=[...bodyBus(-16.25,16.25,C.white,{W,belt:1.0,top:2.75,H:3.2,doors:[12.6,6.9,1.2,-4.5,-10.2]}),
    [bx(-16.25,16.25,.35,.62,W+.02),TRAM_GREEN], [bx(-16.25,16.25,2.75,2.9,W+.02),TRAM_GREEN]];
  for(const x of [-9.75,-3.25,3.25,9.75]) P.push([bx(x-.12,x+.12,.4,3.15,W+.03),C.dark,.7]);            // fuelles entre módulos
  for(const x of [-12.5,-1.5,7.5]) P.push([bx(x-1.4,x+1.4,3.2,3.55,1.8),C.gray]);                     // equipos del techo
  P.push([new THREE.BoxGeometry(1.6,.06,.06).rotateZ(.6).translate(1.0,3.95,0),C.black,.7],[bx(.2,1.9,4.3,4.36,1.2),C.black,.7]);   // pantógrafo
  return [...P, ...wheels([14,8,-8,-14],.36,.25,W)]; }
const TRAM_MODEL={name:'tranvía',w:1,lowCol:C.white,len:TRAM_LEN,bus:true,parts:tranviaParts,
  low:()=>[[bx(-16.25,16.25,.35,1.0,2.6),C.white],[bx(-16.25,16.25,.35,.62,2.62),TRAM_GREEN],[bx(-16.1,16.1,1.0,2.75,2.54),C.glass,.55],[bx(-16.25,16.25,2.75,3.2,2.6),C.white]]};
let TRAM=null, tramState='none', tramActive=[], tramLastScan=0, nTramAll=0, nTram=0, RT=null, tramRails=null, tramT=-1e9, nTramWait=0;
async function loadTram(){
  tramState='loading';
  try{ const r=await fetch(VIVO+'tranvia.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status);
    TRAM=prepBuses(await r.json()); TRAM.off=TRAM_OFF; TRAM.dwell=20; prepTramGrid(); tramState='ready'; okLoad('tram');
    if(PN){ PN.off.fill(NaN); for(const p of peds) if(!p.tr&&tramCerca(...pedXY0(p),0.8)) p.dead=true; } }   // aceras recalculadas sin las vías
  catch(e){ tramState='missing'; retryLater('tram',()=>{ if(tramState==='missing') tramState='none'; },e); }
  panel(); K.dirty();
}
// rejilla con los tramos de vía (cada sentido es un recorrido): para saber rápido si un camino corta una vía
const TG=40, tgrid=new Map();
function prepTramGrid(){
  const pos=[];
  TRAM.shapes.forEach((sh,si)=>{ const c=sh.c, n=c.length/2;
    for(let i=0;i<n-1;i++){ const x0=c[2*i],z0=c[2*i+1],x1=c[2*i+2],z1=c[2*i+3];
      const seg=[si,i,x0,z0,x1,z1];
      for(let ix=Math.floor(Math.min(x0,x1)/TG);ix<=Math.floor(Math.max(x0,x1)/TG);ix++) for(let iz=Math.floor(Math.min(z0,z1)/TG);iz<=Math.floor(Math.max(z0,z1)/TG);iz++){
        const k=ix*100003+iz; let l=tgrid.get(k); if(!l) tgrid.set(k,l=[]); l.push(seg); }
      // carriles: dos a cada lado del eje de su sentido (ancho de vía 1,435 m)
      const L=Math.hypot(x1-x0,z1-z0)||1, nx=-(z1-z0)/L, nz=(x1-x0)/L;
      for(const o of [TRAM_OFF-0.72,TRAM_OFF+0.72]) pos.push(x0+nx*o, Y0-0.3, z0+nz*o, x1+nx*o, Y0-0.3, z1+nz*o); } });
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  tramRails=new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:0x5b4c40,transparent:true,opacity:0.75}));
  tramRails.frustumCulled=false; tramRails.renderOrder=2; root.add(tramRails);
}
// ¿está reservado el punto a D metros del inicio del recorrido 'si'? (algún tranvía encima o a menos de TRAM_ANTES)
function tramOcupado(si,D){ const l=TRAM.occ[si]; if(!l) return false;
  for(let i=0;i<l.length;i+=2) if(D>l[i]-TRAM_DESPUES-TRAM_LEN/2&&D<l[i]+TRAM_LEN/2+TRAM_ANTES*l[i+1]) return true; return false; }
// cortes de un camino recto (x,z)+(dx,dz)·t, t∈[0,len], con las vías → lista de [t, recorrido, D] ordenada por t
const _cortes=[];
function tramCortes(x,z,dx,dz,len){ _cortes.length=0; if(!TRAM||!tgrid.size) return _cortes;
  const x1=x+dx*len, z1=z+dz*len, vis=new Set();
  for(let ix=Math.floor(Math.min(x,x1)/TG);ix<=Math.floor(Math.max(x,x1)/TG);ix++) for(let iz=Math.floor(Math.min(z,z1)/TG);iz<=Math.floor(Math.max(z,z1)/TG);iz++){
    const l=tgrid.get(ix*100003+iz); if(!l) continue;
    for(const s of l){ if(vis.has(s)) continue; vis.add(s);
      const [si,i,ax,az,bx_,bz]=s, ex=bx_-ax, ez=bz-az, den=dx*ez-dz*ex; if(Math.abs(den)<1e-6) continue;   // paralelo: no corta
      const wx=ax-x, wz=az-z, t=(wx*ez-wz*ex)/den, u=(wx*dz-wz*dx)/den;
      // el eje del recorrido va entre las dos vías de su sentido: se amplía un poco el tramo para no colarse por los extremos
      if(t>=-TRAM_OFF&&t<=len&&u>=-0.02&&u<=1.02){ const sh=TRAM.shapes[si]; _cortes.push([t,si,sh.cum[i]+u*Math.hypot(ex,ez)]); } } }
  _cortes.sort((a,b)=>a[0]-b[0]); return _cortes; }
// Para quien avanza por (x,z) con rumbo (dx,dz): distancia a la que debe parar (antes de la primera vía del cruce), o -1.
// Si 'cola' (hueco libre tras el cruce) no basta para salir de las vías con su longitud 'L', también para antes.
function tramParar(x,z,dx,dz,look,L,cola){
  if(!TRAM||performance.now()-tramT>600) return -1;                             // sin tranvías al día: nadie espera
  // se mira también un poco hacia atrás: quien ya está entre las vías de un cruce sigue y sale (nunca se queda en medio)
  const G=TRAM_GRUPO+L/2, cs=tramCortes(x-dx*G,z-dz*G,dx,dz,look+2*G+3); if(!cs.length) return -1;
  // grupos de vías seguidas (los dos sentidos y los recorridos que comparten vía)
  let g0=0;
  for(let i=0;i<=cs.length;i++){
    if(i<cs.length&&(i===g0||cs[i][0]-cs[i-1][0]<TRAM_GRUPO)) continue;
    const t0=cs[g0][0]-G, t1=cs[i-1][0]-G;
    if(t0>look) break;
    if(t0-L/2>-0.3){                                                             // aún no ha pisado la primera vía del grupo
      let res=false; for(let k=g0;k<i&&!res;k++) res=tramOcupado(cs[k][1],cs[k][2]);
      // sin sitio al otro lado para salir entero de las vías: también espera antes
      if(res||(cola!==undefined&&cola<t1+L/2+1.5)) return Math.max(0,t0-L/2-1.5); }
    g0=i; }
  return -1; }
// ¿hay vía a menos de 'r' m de (x,z)? (para no hacer aparecer coches encima)
function tramCerca(x,z,r){ if(!TRAM) return false; const l=tgrid.get(Math.floor(x/TG)*100003+Math.floor(z/TG)); if(!l) return false;
  for(const [,,ax,az,bx_,bz] of l){ const ex=bx_-ax, ez=bz-az, L2=ex*ex+ez*ez||1, u=Math.max(0,Math.min(1,((x-ax)*ex+(z-az)*ez)/L2));
    if(Math.hypot(ax+ex*u-x,az+ez*u-z)<r+TRAM_OFF+1) return true; } return false; }
function tramStep(now,dt,draw){
  const t=secNow(); tramT=performance.now();
  if(now-tramLastScan>1000){ tramLastScan=now; tramActive=[];
    const S=TRAM.starts; let lo=0,hi=S.length; const from=t-TRAM.maxDur; while(lo<hi){ const m=(lo+hi)>>1; if(S[m]<from) lo=m+1; else hi=m; }
    for(let i=lo;i<S.length&&S[i]<=t;i++){ const tr=TRAM.trips[i]; if(tr.st+tr.du>=t) tramActive.push(tr); }
    nTramAll=tramActive.length; }
  // reservas: por recorrido, posición de cada tranvía y si se mueve (parado en el andén reserva menos por delante)
  const occ=TRAM.occ||(TRAM.occ=[]); for(const l of occ) if(l) l.length=0;
  let n=0; const R2=(area.r*1.3)**2;
  for(const tr of tramActive){ busPos(tr,t,PB,TRAM); const si=TRAM.d.patrones[tr.p][1], dd=tr.dd;
    const mov=tr.ddPrev===undefined?1:Math.min(1,Math.abs(dd-tr.ddPrev)/Math.max(dt,1e-3)/2+0.35); tr.ddPrev=dd;
    (occ[si]||(occ[si]=[])).push(dd,mov);
    if(!draw||!RT||(PB[0]-area.x)**2+(PB[1]-area.z)**2>R2||n>=RT.cap) continue;
    writePose(RT.mat.array,n,PB[0],PB[1],PB[2],PB[3]*VSC); const c=RT.color.array; c[n*3]=c[n*3+1]=c[n*3+2]=1; n++; }
  if(RT) setCount(RT,draw?n:0); nTram=draw?n:0;
}

/* ================= Ciclistas de Bicing ================= */
// Cada bici que se coge o se deja (dato real del último minuto) se convierte en un ciclista: los que salen arrancan
// en su estación hacia un destino probable; los que llegan aparecen a poca distancia y aparcan en su estación.
// El trayecto es estimado (Bicing no publica origen-destino): ruta más cómoda por carril bici y calles tranquilas.
const CYC_MPP=0.9, CYC_CAP=260;
const RIDER=[C.blue,C.green,C.ochre,C.white,C.black,C.red,0x8a7aa8,C.teal,C.silver];
function bici(frame,bat){ return [
  ...[0.55,-0.55].map(x=>[new THREE.CylinderGeometry(.34,.34,.05,10).rotateX(Math.PI/2).translate(x,.34,0),C.tire,.5]),
  [bx(-.55,.55,.5,.56,.05),frame], [bx(-.12,-.06,.5,.95,.05),frame], [bx(.45,.52,.5,1.0,.05),frame],
  [bx(.42,.74,.76,.98,.36),frame,.8],                       // cesta delantera de Bicing
  [bx(.35,.6,1.0,1.04,.5),C.dark,.7],                       // manillar
  ...(bat?[[bx(-.05,.32,.56,.7,.12),C.black,.7]]:[]),        // batería de la eléctrica
  [bx(-.2,.05,.55,1.0,.26),C.dark,.7],                      // piernas
  [bx(-.28,.12,1.0,1.48,.36),BODY],                         // tronco: color de la ropa
  ...both(g=>[bx(0,.42,1.25,1.34,.09,g*.17),BODY]),
  [new THREE.IcosahedronGeometry(.13,0).translate(.02,1.62,0),0xe3bd98,1]]; }
const BIKE_MODELS=[
  {name:'bici mecánica',w:1,len:1.8,pal:RIDER,parts:()=>bici(0xc8402a,false),low:()=>[[bx(-.8,.8,.1,.95,.14),0xc8402a],[bx(-.25,.15,.95,1.65,.36),BODY]]},
  {name:'bici eléctrica',w:1,len:1.8,pal:RIDER,parts:()=>bici(0x4f7fa0,true),low:()=>[[bx(-.8,.8,.1,.95,.14),0x4f7fa0],[bx(-.25,.15,.95,1.65,.36),BODY]]}];
let RBC=null, BK=null, bkState='none', cycs=[], cycQueue=[], nCyc=0, cycSeen=null;
const cycArea={x:0,z:0,r:300};
async function loadBici(){
  bkState='loading';
  try{ const r=await fetch(VIVO+'bici.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status); BK=prepBici(await r.json()); bkState='ready'; okLoad('bici');
       if(BIKE){ queueBikeEvents(BIKE); warmStart(); } }                      // eventos del último minuto + viajes ya en curso
  catch(e){ bkState='missing'; retryLater('bici',()=>{ if(bkState==='missing') bkState='none'; },e); }
  panel();
}
function prepBici(d){
  const N=d.nodos.length, nx=new Float32Array(N), nz=new Float32Array(N);
  d.nodos.forEach((p,i)=>{ nx[i]=p[0]; nz[i]=p[1]; });
  const E=d.tramos.map(r=>{ const c=Float32Array.from(r[5]); let L=0; for(let i=2;i<c.length;i+=2) L+=Math.hypot(c[i]-c[i-2],c[i+1]-c[i-1]);
    return {a:r[0],b:r[1],w:r[2],one:r[3],off:r[4],c,len:L}; });
  const deg=new Int32Array(N+1); E.forEach(e=>{ deg[e.a]++; if(!e.one) deg[e.b]++; });
  const head=new Int32Array(N+1); for(let i=0;i<N;i++) head[i+1]=head[i]+deg[i];
  const fill=head.slice(0,N), adj=new Int32Array(head[N]);
  E.forEach((e,i)=>{ adj[fill[e.a]++]=i*2; if(!e.one) adj[fill[e.b]++]=i*2+1; });
  const CELL=60, grid=new Map(); for(let i=0;i<N;i++){ const k=Math.floor(nx[i]/CELL)*100003+Math.floor(nz[i]/CELL); let l=grid.get(k); if(!l) grid.set(k,l=[]); l.push(i); }
  return {N,nx,nz,E,head,adj,grid,CELL};
}
function nearestNode(x,z){ const {grid,CELL,nx,nz}=BK; let best=-1,bd=1e18;
  for(let r=0;r<3&&best<0;r++) for(let ix=Math.floor(x/CELL)-r;ix<=Math.floor(x/CELL)+r;ix++) for(let iz=Math.floor(z/CELL)-r;iz<=Math.floor(z/CELL)+r;iz++){
    const l=grid.get(ix*100003+iz); if(l) for(const i of l){ const d=(nx[i]-x)**2+(nz[i]-z)**2; if(d<bd){ bd=d; best=i; } } }
  return best; }
// A* con montículo binario; coste = metros × preferencia de la vía
function route(from,to){
  const {N,nx,nz,E,head,adj}=BK; if(from<0||to<0||from===to) return null;
  const g=new Float64Array(N).fill(Infinity), via=new Int32Array(N).fill(-1), done=new Uint8Array(N);
  const H=[], push=(f,n)=>{ H.push([f,n]); let i=H.length-1; while(i>0){ const p=(i-1)>>1; if(H[p][0]<=H[i][0]) break; [H[p],H[i]]=[H[i],H[p]]; i=p; } };
  const pop=()=>{ const top=H[0], last=H.pop(); if(H.length){ H[0]=last; let i=0; for(;;){ const l=2*i+1,r=l+1; let m=i;
      if(l<H.length&&H[l][0]<H[m][0]) m=l; if(r<H.length&&H[r][0]<H[m][0]) m=r; if(m===i) break; [H[m],H[i]]=[H[i],H[m]]; i=m; } } return top; };
  const hx=n=>Math.hypot(nx[n]-nx[to],nz[n]-nz[to])*0.6;
  g[from]=0; push(hx(from),from); let it=0;
  while(H.length&&it++<60000){ const [,n]=pop(); if(done[n]) continue; done[n]=1; if(n===to) break;
    for(let k=head[n];k<head[n+1];k++){ const p=adj[k], e=E[p>>1], m=(p&1)?e.a:e.b, ng=g[n]+e.len*e.w;
      if(ng<g[m]){ g[m]=ng; via[m]=p; push(ng+hx(m),m); } } }
  if(via[to]<0) return null;
  const steps=[]; for(let n=to;n!==from;){ const p=via[n]; steps.push(p); const e=E[p>>1]; n=(p&1)?e.b:e.a; if(steps.length>5000) return null; }
  steps.reverse();
  // polilínea desplazada a la derecha de cada tramo
  const pts=[]; for(const p of steps){ const e=E[p>>1], c=e.c, n=c.length/2, rev=p&1;
    for(let j=0;j<n-1;j++){ const i0=rev?n-1-j:j, i1=rev?n-2-j:j+1; const x0=c[2*i0],z0=c[2*i0+1],x1=c[2*i1],z1=c[2*i1+1], L=Math.hypot(x1-x0,z1-z0)||1;
      const ox=-(z1-z0)/L*e.off, oz=(x1-x0)/L*e.off; if(!pts.length) pts.push(x0+ox,z0+oz); pts.push(x1+ox,z1+oz); } }
  const P=Float32Array.from(pts), n=P.length/2, cu=new Float32Array(n); for(let i=1;i<n;i++) cu[i]=cu[i-1]+Math.hypot(P[2*i]-P[2*i-2],P[2*i+1]-P[2*i-1]);
  return {P,cu,len:cu[n-1]};
}
function queueBikeEvents(d){
  if(!d||!d.eventos||cycSeen===d.ts) return; cycSeen=d.ts;
  const st=new Map(d.estaciones.map(e=>[e[0],e])), now=performance.now();
  for(const [id,n,tipo] of d.eventos){ const e=st.get(id); if(!e) continue;      // se filtra por distancia al salir
    for(let k=0;k<Math.min(Math.abs(n),3);k++) cycQueue.push({at:now+Math.random()*55000,sale:n<0,ele:tipo.startsWith('el'),x:e[1],z:e[2]}); }
}
// Arranque en caliente: los viajes que ya estarían en marcha al abrir el mapa, al ritmo real de salidas
// (cogidas en el último minuto × ~12 min de viaje medio), en estaciones cercanas y en un punto al azar de su trayecto.
// Se repite en cada zona nueva a la que se va (saltando o arrastrando lejos): así ninguna calle está vacía al llegar.
const warmSpots=[];
function warmStart(){ const c=K.intro||K.controls.target; warmAt(c.x,c.z,K.intro?1500:3200); }   // alrededor del punto al que vuela la entrada, si lo hay
function warmAt(x,z,R){
  warmSpots.push({x,z});
  const T=BIKE.totales||{}, st=BIKE.estaciones, now=performance.now();
  // Al abrir solo hay una lectura de Bicing (sin cogidas que comparar): se usa el ritmo típico de Barcelona,
  // ~55 bicis cogidas por minuto en hora punta, según la hora.
  const cerca=st.filter(e=>Math.hypot(e[1]-x,e[2]-z)<R);
  const cogidas=T.cogidas||Math.round(55*PHOUR[Math.floor(horaBcn())%24]);
  const n=Math.min(180,Math.round(cogidas*12*cerca.length/Math.max(1,st.length)));
  for(let i=0;i<n;i++){ const e=cerca[(Math.random()*cerca.length)|0]; if(e) cycQueue.push({at:now,sale:true,warm:true,ele:Math.random()<(T.electricas||1)/((T.mecanicas||1)+(T.electricas||1)),x:e[1],z:e[2]}); }
}
function otherStation(x,z,dmin,dmax){ const st=BIKE.estaciones;
  for(let t=0;t<25;t++){ const e=st[(Math.random()*st.length)|0], d=Math.hypot(e[1]-x,e[2]-z); if(d>dmin&&d<dmax) return e; } return null; }
function spawnCyclist(ev){
  const o=otherStation(ev.x,ev.z,600,2800); if(!o) return;
  const here=nearestNode(ev.x,ev.z), there=nearestNode(o[1],o[2]);
  const r=ev.sale?route(here,there):route(there,here); if(!r||r.len<50) return;
  const v=(ev.ele?5.2:4.2)+(Math.random()-0.5)*1.2, T=8+Math.random()*50;
  const c=new THREE.Color(RIDER[(Math.random()*RIDER.length)|0]);
  cycs.push({...r,s:ev.warm?Math.random()*r.len*0.9:ev.sale?0:Math.max(0,r.len-v*T),v,m:ev.ele?1:0,age:0,fade:-1,col:[c.r,c.g,c.b],sale:ev.sale});
}
function cycStep(now,dt){
  const t=K.controls.target, cam=K.cam, hh=(cam.top-cam.bottom)/cam.zoom/2, hw=(cam.right-cam.left)/cam.zoom/2;
  cycArea.x=t.x; cycArea.z=t.z; cycArea.r=Math.min(1600,Math.max(220,Math.max(hh*1.6,hw)*1.15));
  if(!warmSpots.some(s=>Math.hypot(s.x-t.x,s.z-t.z)<1200)){                         // zona nueva: los viajes que ya estarían en marcha aquí
    cycQueue=cycQueue.filter(q=>!q.warm||Math.hypot(q.x-t.x,q.z-t.z)<3200); warmAt(t.x,t.z,1500); }
  let budget=cycs.length<40?3:1;                                                     // una ruta nueva por fotograma (A* no es gratis)
  while(cycQueue.length&&budget>0){ let i=cycQueue.findIndex(q=>q.at<=now); if(i<0) break; const ev=cycQueue.splice(i,1)[0];
    const d=Math.hypot(ev.x-cycArea.x,ev.z-cycArea.z);
    if(d<(ev.sale?3200:cycArea.r*1.3)&&cycs.length<CYC_CAP*2){ spawnCyclist(ev); budget--; } }   // los que salen lejos pueden cruzar la vista
  for(const r of RBC) r.n=0; nCyc=0; nCycLight=0;
  const R2=(cycArea.r*1.4)**2;
  cycs=cycs.filter(c=>{
    c.age+=dt;
    if(c.fade>=0){ c.fade-=dt; if(c.fade<=0) return false; }
    else{ const ease=c.sale?Math.min(1,0.35+c.s/8):1, rem=c.len-c.s; let ds=c.v*ease*Math.min(1,0.3+rem/10)*dt;   // arranca y frena en la estación
      if(c.x!==undefined&&RED&&(c.x-cycArea.x)**2+(c.z-cycArea.z)**2<(cycArea.r*1.4)**2){    // semáforo en rojo delante: espera
        const g=stopForLight(c.x,c.z,c.ang,0.9,c.cv||c.v,2.5,20,6); if(g>=0&&g<ds){ ds=Math.max(0,g); nCycLight++; } }
      if(c.x!==undefined&&TRAM){ const g=tramParar(c.x,c.z,Math.cos(c.ang),Math.sin(c.ang),Math.max(4,ds+3),1.8);   // tranvía: prioridad
        if(g>=0&&g<ds){ ds=Math.max(0,g); nTramWait++; } }
      c.cv=ds/Math.max(dt,1e-3); c.s+=ds;
      if(c.s>=c.len-0.3){ c.s=c.len; c.fade=0.6; } }
    const n=c.cu.length; let lo=0,hi=n-2; while(lo<hi){ const m=(lo+hi+1)>>1; if(c.cu[m]<=c.s) lo=m; else hi=m-1; }
    const L=(c.cu[lo+1]-c.cu[lo])||1, u=Math.min(1,Math.max(0,(c.s-c.cu[lo])/L)), dx=(c.P[2*lo+2]-c.P[2*lo])/L, dz=(c.P[2*lo+3]-c.P[2*lo+1])/L;
    const x=c.P[2*lo]+dx*L*u, z=c.P[2*lo+1]+dz*L*u; c.x=x; c.z=z; c.ang=Math.atan2(dz,dx);
    if((x-cycArea.x)**2+(z-cycArea.z)**2>R2){ const ahead=c.len-c.s;     // lejos: sigue su camino sin dibujarse
      return ahead>0&&c.age<1800; }
    const r=RBC[c.m]; if(r.n>=r.cap) return true;
    const sc=c.fade>=0?c.fade/0.6:Math.min(1,c.age/0.6);
    writePose(r.mat.array,r.n,x,z,Math.atan2(-dz,dx),sc);
    const C3=r.color.array; C3[r.n*3]=c.col[0]; C3[r.n*3+1]=c.col[1]; C3[r.n*3+2]=c.col[2]; r.n++; nCyc++;
    return true; });
  for(const r of RBC) setCount(r,r.n);
}

/* ================= Personas (estimadas: no hay datos abiertos de peatones) ================= */
// Caminan por las aceras de la red viaria (a cada lado de la calzada, pasada la fila de aparcados). En cada esquina
// siguen por el camino más corto a la siguiente acera, así que como mucho cruzan una calle (nunca en diagonal), y en
// los cruces con semáforo esperan a que su sentido tenga verde con tiempo para cruzar. Cuánta gente: tipo de calle ×
// hora del día × tiempo real (menos con lluvia, nieve o tormenta). Solo de cerca, como los ciclistas.
const PED_MPP=0.35, PED_HI=0.12, PED_CAP=700, PED_MAX=MOVIL?1000:2400;
const PHOUR=[.1,.06,.04,.03,.03,.06,.15,.4,.65,.65,.7,.8,.9,.9,.8,.75,.8,.9,1,1,.85,.6,.38,.2];   // gente en la calle según la hora
const PDENS=[0,.12,.15,.18,.2,.2,.17,.14];        // personas por metro de calle (las dos aceras) en hora punta; 0 = vía rápida
const ACERA=1.3, ACERA_J=0.9;                     // del borde del asfalto a la persona (+ hasta 0,9 m más, cada una a su aire)
const ROPA=[C.blue,C.green,C.ochre,C.white,C.black,C.red,0x8a7aa8,C.teal,C.silver,C.cream,C.wine,0x6a5a4c];
function persona(leg,skin){ return [
  ...both(g=>[bx(-.08,.08,0,.86,.13,g*.1),leg]),                         // piernas
  [bx(-.12,.12,.84,1.42,.38),BODY],                                        // tronco: color de la ropa
  ...both(g=>[bx(-.06,.06,.9,1.38,.08,g*.23),BODY,.85]),                   // brazos
  [new THREE.IcosahedronGeometry(.12,0).translate(0,1.57,0),skin,1]]; }
const pModel=(name,leg,skin)=>({name,w:1,len:.4,pal:ROPA,parts:()=>persona(leg,skin),low:()=>[[bx(-.12,.12,0,1.42,.36),BODY],[bx(-.09,.09,1.44,1.7,.2),skin]]});
const PED_MODELS=[pModel('pantalón oscuro',C.dark,0xe3bd98),pModel('vaqueros',0x5f6f86,0xd2a27c),pModel('pantalón negro',C.black,0x8a5d3e),pModel('pantalón claro',0x9a8a70,0xf0cfb0)];
let PEDR=null, PN=null, peds=[], pedCand=[], pedCum=new Float64Array(0), pedTot=0, pedLast=0, pedFirst=true, nPed=0, nPedWait=0, pedTarget=0;
const pedArea={x:0,z:0,r:0}, PA=new Float32Array(4), PQ=new Float32Array(4);
/* --- El asfalto que se ve: los mismos polígonos de calzada que dibuja index.html (base/X_Y.json), calcados en trozos
       de 500 m con píxeles de 1 m. Cada acera empieza justo donde acaba ese asfalto, así nadie camina por la carretera. --- */
const MCH=500, MCH_MAX=48, mchunks=new Map();
let CALZ=null, calzState='none', mcan=null, mctx=null;
async function loadCalzada(){
  calzState='loading';
  try{ const idx=await fetch(K.BASE+'index.json',{cache:'no-cache'}).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); });
    const files=((idx.base&&idx.base.tiles)||[]).map(t=>t.file), grid=new Map();
    const tiles=await Promise.all(files.map(f=>fetch(K.BASE+f,{cache:'no-cache'}).then(r=>r.ok?r.json():null).catch(()=>null)));
    let n=0;
    for(const t of tiles) for(const p of ((t&&t.layers&&t.layers.calzada)||[])){ const rings=[p.o,...(p.i||[])]; let x0=1e9,z0=1e9,x1=-1e9,z1=-1e9;
      for(const q of p.o){ if(q[0]<x0)x0=q[0]; if(q[0]>x1)x1=q[0]; if(q[1]<z0)z0=q[1]; if(q[1]>z1)z1=q[1]; }
      const poly={rings}; n++;
      for(let ix=Math.floor(x0/MCH);ix<=Math.floor(x1/MCH);ix++) for(let iz=Math.floor(z0/MCH);iz<=Math.floor(z1/MCH);iz++){
        const k=ix*100003+iz; let l=grid.get(k); if(!l) grid.set(k,l=[]); l.push(poly); } }
    if(!n) throw new Error('sin calzada');
    CALZ={grid,n}; calzState='ready'; okLoad('calzada');
  }catch(e){ calzState='missing'; retryLater('calzada',()=>{ if(calzState==='missing') calzState='none'; },e); }
  panel(); K.dirty();
}
function maskChunk(ix,iz){
  const k=ix*100003+iz; let m=mchunks.get(k); if(m) return m;
  if(!mcan){ mcan=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(MCH,MCH):Object.assign(document.createElement('canvas'),{width:MCH,height:MCH}); mctx=mcan.getContext('2d',{willReadFrequently:true}); }
  const g=mctx; g.setTransform(1,0,0,1,0,0); g.clearRect(0,0,MCH,MCH); g.setTransform(1,0,0,1,-ix*MCH,-iz*MCH); g.fillStyle='#fff';
  for(const poly of (CALZ.grid.get(k)||[])){ const path=new Path2D();
    for(const r of poly.rings){ if(!r||r.length<3) continue; path.moveTo(r[0][0],r[0][1]); for(let i=1;i<r.length;i++) path.lineTo(r[i][0],r[i][1]); path.closePath(); }
    g.fill(path,'evenodd'); }
  const d=g.getImageData(0,0,MCH,MCH).data; m=new Uint8Array(MCH*MCH); for(let i=0;i<m.length;i++) m[i]=d[i*4]>100?1:0;
  if(mchunks.size>=MCH_MAX) mchunks.delete(mchunks.keys().next().value);       // se olvida el trozo más antiguo
  mchunks.set(k,m); return m; }
function isRoad(x,z){ const ix=Math.floor(x/MCH), iz=Math.floor(z/MCH), m=maskChunk(ix,iz);
  return m[Math.floor(z-iz*MCH)*MCH+Math.floor(x-ix*MCH)]===1; }
const NO_ACERA=99;
function prepPed(){
  const E=RED.E, N=RED.nx.length, adj=Array.from({length:N},()=>[]), all=Array.from({length:N},()=>[]);
  E.forEach((e,i)=>{ all[e.a].push(i); all[e.b].push(i); if(e.cls>0){ adj[e.a].push(i); adj[e.b].push(i); } });
  PN={adj,all,off:new Float32Array(E.length*2).fill(NaN)};
}
// punto de la calle 'e' a 'u' metros desde su nodo a, desplazado 'lat' metros a su derecha (sentido a→b)
function edgePt(e,u,lat,o){ const c=e.c, cu=e.cum, n=cu.length; let lo=0,hi=n-2; while(lo<hi){ const m=(lo+hi+1)>>1; if(cu[m]<=u) lo=m; else hi=m-1; }
  const L=(cu[lo+1]-cu[lo])||1, f=Math.min(1,Math.max(0,(u-cu[lo])/L)), dx=(c[2*lo+2]-c[2*lo])/L, dz=(c[2*lo+3]-c[2*lo+1])/L;
  o[0]=c[2*lo]+dx*L*f-dz*lat; o[1]=c[2*lo+1]+dz*L*f+dx*lat; o[2]=dx; o[3]=dz; }
// distancia del eje de la calle 'i' al borde del asfalto por su lado s (+1 derecha, −1 izquierda); se mide en 3 puntos
// y se queda la mediana (así una bocacalle no la estropea). NO_ACERA si en 30 m no se sale del asfalto.
const _sd=[];
function sideDist(i,s){ const k=2*i+(s>0?0:1); let v=PN.off[k]; if(v===v) return v;
  const e=RED.E[i]; _sd.length=0;
  for(const f of [0.3,0.5,0.7]){ edgePt(e,e.len*f,0,PQ); const x=PQ[0], z=PQ[1], nx=-PQ[3]*s, nz=PQ[2]*s;
    let t=0; while(t<=30&&isRoad(x+nx*t,z+nz*t)) t+=0.5; if(t<=30) _sd.push(t); }
  _sd.sort((a,b)=>a-b); v=_sd.length>=2?_sd[_sd.length>>1]:NO_ACERA;
  if(v<NO_ACERA&&TRAM){ let enVia=0;                                            // esa «acera» cae en la plataforma del tranvía: no se camina por ahí
    // 5 puntos: si 2 o más caen en la vía, la acera va a lo largo de ella (una calle que solo la cruza toca 1 como mucho)
    for(const f of [0.1,0.3,0.5,0.7,0.9]){ edgePt(e,e.len*f,s*(v+ACERA+0.5),PQ); if(tramCerca(PQ[0],PQ[1],0.9)) enVia++; }
    if(enVia>=2) v=NO_ACERA; }
  PN.off[k]=v; return v; }
const latOf=(i,s,p)=>s*(sideDist(i,s)+ACERA+p.j);
// en un cruce, la acera se corta donde empieza la acera de las otras calles que llegan a él
function trimAt(node,self){ if(RED.deg[node]<=2) return 0; let m=0;
  for(const i of PN.all[node]){ if(i===self) continue; for(const s of [1,-1]){ const d=sideDist(i,s); if(d<NO_ACERA&&d+ACERA>m) m=d+ACERA; } }
  return Math.min(20,m); }
function pedRange(p){ const e=RED.E[p.e]; p.u0=Math.min(trimAt(e.a,p.e),e.len*0.45); p.u1=Math.max(e.len-trimAt(e.b,p.e),e.len*0.55); p.W=p.u1-p.u0; }
// segundos de verde que le quedan a quien cruza con rumbo 'ang' (= atan2(dz,dx)); 0 si está en ámbar o rojo
function pedGreen(node,ang){ const g=grpOf(node,ang), t=(performance.now()/1000+RED.off[node])%CYCLE, ph=g?(t+CYCLE/2)%CYCLE:t; return ph<GREEN?GREEN-ph:0; }
function planNext(p){
  const E=RED.E, e=E[p.e], end=p.dir?e.a:e.b, opts=PN.adj[end];
  edgePt(e,p.dir?p.u0:p.u1,p.lat,PA); const x0=PA[0], z0=PA[1];
  let best=null;
  for(let k=0;k<6&&!best;k++){
    const b=opts.length>1&&k<5?opts[(Math.random()*opts.length)|0]:p.e; if(b===p.e&&k<5&&opts.length>1) continue;
    const eb=E[b], db=eb.a===end?0:1, ub0=Math.min(trimAt(eb.a,b),eb.len*0.45), ub1=Math.max(eb.len-trimAt(eb.b,b),eb.len*0.55), us=db?ub1:ub0;
    for(const s of [1,-1]){ if(sideDist(b,s)>=NO_ACERA) continue;                 // ese lado no tiene acera (asfalto hasta 30 m)
      const lat=latOf(b,s,p); edgePt(eb,us,lat,PQ); const L=Math.hypot(PQ[0]-x0,PQ[1]-z0);
      if(!best||L<best.L) best={e:b,dir:db,lat,x1:PQ[0],z1:PQ[1],L}; } }            // la acera de llegada más cercana: como mucho se cruza una calle
  if(!best) best={e:p.e,dir:p.dir?0:1,lat:p.lat,x1:x0,z1:z0,L:0};                   // sin salida: media vuelta por la misma acera
  p.nx={...best,x0,z0,node:end,sig:RED.sig[end]===1&&best.L>5,ang:Math.atan2(best.z1-z0,best.x1-x0)};
}
const pedXY0=p=>{ pedPos(p,PA); return [PA[0],PA[1]]; };
function pedPos(p,o){
  if(p.tr){ const t=p.tr, f=t.L>0.01?Math.min(1,t.s/t.L):1; o[0]=t.x0+(t.x1-t.x0)*f; o[1]=t.z0+(t.z1-t.z0)*f; o[2]=-t.ang; return; }
  const e=RED.E[p.e]; edgePt(e,p.dir?p.u1-p.s:p.u0+p.s,p.lat,o); const hx=p.dir?-o[2]:o[2], hz=p.dir?-o[3]:o[3];
  o[2]=p.waiting&&p.nx?-p.nx.ang:Math.atan2(-hz,hx); }
function pedUpdateArea(){
  const t=K.controls.target, cam=K.cam, hh=(cam.top-cam.bottom)/cam.zoom/2, hw=(cam.right-cam.left)/cam.zoom/2;
  const stretch=1/Math.max(0.35,Math.cos(K.controls.getPolarAngle?K.controls.getPolarAngle():0.9));
  const r=Math.min(700,Math.max(150,Math.max(hh*stretch,hw)*1.1));
  if(pedArea.r&&Math.hypot(t.x-pedArea.x,t.z-pedArea.z)<r*0.2&&Math.abs(r-pedArea.r)<pedArea.r*0.25) return;
  if(pedArea.r&&Math.hypot(t.x-pedArea.x,t.z-pedArea.z)>pedArea.r) pedFirst=true;      // salto lejos: llenar de golpe
  pedArea.x=t.x; pedArea.z=t.z; pedArea.r=r;
  const {E,cells,CELL}=RED; pedCand=[];
  for(let ix=Math.floor((t.x-r)/CELL);ix<=Math.floor((t.x+r)/CELL);ix++) for(let iz=Math.floor((t.z-r)/CELL);iz<=Math.floor((t.z+r)/CELL);iz++){
    const l=cells.get(ix+','+iz); if(l) for(const i of l){ const e=E[i]; if(e.cls>0&&Math.hypot(e.mx-t.x,e.mz-t.z)<r*1.1) pedCand.push(i); } }
  pedCum=new Float64Array(pedCand.length); let s=0; pedCand.forEach((i,k)=>{ s+=E[i].len*PDENS[E[i].cls]; pedCum[k]=s; }); pedTot=s;
}
// menos gente de madrugada, con lluvia, nieve o tormenta (el tiempo real o el forzado con «Clima»)
const pedF=()=>PHOUR[horaBcn()]*(1-0.6*WXV.rain)*(1-0.5*WXV.snow)*(1-0.4*WXV.storm);
function newPed(anywhere){
  if(!pedCand.length||pedTot<=0) return false;
  for(let t=0;t<10;t++){
    const p={e:pick(pedCand,pedCum),dir:Math.random()<0.5?0:1,j:Math.random()*ACERA_J,v:1.0+Math.random()*0.55,back:0.3+Math.random()*1.3,age:0,fade:-1,tr:null,nx:null};
    let s=Math.random()<0.5?1:-1; if(sideDist(p.e,s)>=NO_ACERA){ s=-s; if(sideDist(p.e,s)>=NO_ACERA) continue; }
    pedRange(p); p.s=Math.random()*p.W; p.lat=latOf(p.e,s,p);
    pedPos(p,PA); if(!anywhere&&t<8&&!offScreen(PA[0],PA[1])) continue;
    p.r=(Math.random()*PED_MODELS.length)|0; const c=new THREE.Color(ROPA[(Math.random()*ROPA.length)|0]); p.col=[c.r,c.g,c.b];
    peds.push(p); return true; }
  return false;
}
function pedSync(now){
  if(now-pedLast<500) return; pedLast=now; pedUpdateArea();
  pedTarget=Math.min(PED_MAX,Math.round(pedTot*pedF()));
  let n=0; for(const p of peds) if(!p.remove) n++;
  const fill=pedFirst||n<pedTarget*0.7; let budget=fill?400:60;
  while(n<pedTarget&&budget-->0){ if(!newPed(fill)) break; n++; }
  for(const p of peds){ if(n<=pedTarget) break; if(!p.remove&&p.fade<0){ p.remove=true; p.fade=0.6; n--; } }
  pedFirst=false;
}
// tranvía: si su camino corta una vía reservada, espera antes de la primera (los que ya están entre las vías siguen)
function pedTram(p,ds){ if(!TRAM) return false;
  pedPos(p,PQ); const g=tramParar(PQ[0],PQ[1],Math.cos(PQ[2]),-Math.sin(PQ[2]),ds+1.2,0.5);
  if(g>=0&&g<ds+0.01){ p.waiting=true; nPedWait++; nTramWait++; return true; } return false; }
function pedMove(p,dt){
  p.age+=dt; p.waiting=false;
  if(p.fade>=0){ p.fade-=dt; if(p.fade<=0) p.dead=true; return; }
  if(p.tr){ if(pedTram(p,p.v*dt)) return; p.tr.s+=p.v*dt; if(p.tr.s>=p.tr.L){ const n=p.tr; p.e=n.e; p.dir=n.dir; p.lat=n.lat; p.tr=null; p.nx=null; pedRange(p); p.s=0; } return; }
  if(!p.nx&&p.s>p.W-6) planNext(p);
  let ds=p.v*dt;
  if(pedTram(p,ds)) return;
  if(p.nx&&p.nx.sig&&!p.go){ const stop=p.W-p.back;                           // semáforo: espera en el bordillo al verde de su sentido
    if(p.s+ds>=stop){ if(pedGreen(p.nx.node,p.nx.ang)>p.nx.L/p.v+1) p.go=true; else{ ds=Math.max(0,stop-p.s); p.waiting=true; nPedWait++; } } }
  p.s+=ds;
  if(p.s>=p.W){ if(!p.nx) planNext(p); p.tr={...p.nx,s:0}; p.go=false; }
}
function pedFrame(now,dt){
  pedSync(now);
  const R=PEDR, R2=(pedArea.r*1.3)**2; for(const r of R) r.n=0; nPed=0; nPedWait=0;
  for(const p of peds){ if(p.dead) continue; pedMove(p,dt); if(p.dead) continue;
    pedPos(p,PA); if((PA[0]-pedArea.x)**2+(PA[1]-pedArea.z)**2>R2){ p.dead=true; continue; }   // salió del área: otra aparecerá fuera de la vista
    const r=R[p.r]; if(r.n>=r.cap) continue;
    const sc=p.fade>=0?Math.max(0,p.fade/0.6):Math.min(1,p.age/0.6);
    writePose(r.mat.array,r.n,PA[0],PA[1],PA[2],sc,0.3);
    const c=r.color.array; c[r.n*3]=p.col[0]; c[r.n*3+1]=p.col[1]; c[r.n*3+2]=p.col[2]; r.n++; nPed++; }
  if(peds.some(p=>p.dead)) peds=peds.filter(p=>!p.dead);
  for(const r of R) setCount(r,r.n);
}

/* ================= Tráfico: tramos municipales pintados según su estado ================= */
const TCOL=[0xbfb39c,0x6e9e5c,0x9bb86a,0xe0b040,0xd9772f,0xbf3a2a,0x3a2616].map(h=>new THREE.Color(h));
const ribbonMat=new THREE.ShaderMaterial({
  uniforms:{w:{value:2},op:{value:0.9}},
  vertexShader:`attribute vec2 aDir; attribute float aSide; attribute vec3 aC; uniform float w; varying vec3 vC;
    void main(){ vec3 p=position; p.x+=-aDir.y*aSide*w; p.z+=aDir.x*aSide*w; vC=aC; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0); }`,
  fragmentShader:`uniform float op; varying vec3 vC; void main(){ gl_FragColor=vec4(vC,op); }`,
  transparent:true,depthWrite:false});
let ribbon=null, ribbonIdx=new Map(), tramosState='none';
async function loadTramos(){
  tramosState='loading';
  try{ const r=await fetch(VIVO+'tramos.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status); buildRibbons(await r.json()); tramosState='ready'; okLoad('tramos'); recolor(); }
  catch(e){ tramosState='missing'; retryLater('tramos',()=>{ if(tramosState==='missing'){ tramosState='none'; if(TRAF) loadTramos(); } },e); }
  panel(); K.dirty();
}
function buildRibbons(d){
  const pos=[],dir=[],side=[],col=[],idx=[]; let v=0;
  for(const [id,,c] of d.tramos){ const start=v;
    for(let i=0;i+3<c.length;i+=2){ const x0=c[i],z0=c[i+1],x1=c[i+2],z1=c[i+3],L=Math.hypot(x1-x0,z1-z0); if(L<0.3) continue;
      const dx=(x1-x0)/L, dz=(z1-z0)/L;
      for(const [x,z] of [[x0,z0],[x1,z1]]) for(const s of [-1,1]){ pos.push(x,0.48,z); dir.push(dx,dz); side.push(s); col.push(.75,.7,.6); }
      idx.push(v,v+2,v+1, v+1,v+2,v+3); v+=4; }
    if(v>start) ribbonIdx.set(id,[start,v-start]); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.setAttribute('aDir',new THREE.Float32BufferAttribute(dir,2));
  g.setAttribute('aSide',new THREE.Float32BufferAttribute(side,1)); g.setAttribute('aC',new THREE.Float32BufferAttribute(col,3));
  g.setIndex(idx); g.computeBoundingSphere();
  ribbon=new THREE.Mesh(g,ribbonMat); ribbon.frustumCulled=false; ribbon.renderOrder=2; ribbonGroup.add(ribbon);
}
function recolor(){
  if(!ribbon) return; const a=ribbon.geometry.attributes.aC, arr=a.array;
  for(const [id,[s,n]] of ribbonIdx){ const c=TCOL[(TRAF&&TRAF.get(id))||0]; for(let i=s;i<s+n;i++){ arr[i*3]=c.r; arr[i*3+1]=c.g; arr[i*3+2]=c.b; } }
  a.needsUpdate=true;
}

/* ================= Bicing: barras por estación ================= */
const barMat=new THREE.ShaderMaterial({
  uniforms:{mpp:U.mpp,L:{value:LDIR}},
  vertexShader:`attribute vec4 aBar; attribute float aW; attribute vec3 aColor; uniform float mpp; varying vec3 vC; varying vec3 vN;
    void main(){ float wd=max(aW,mpp*5.0); vec3 p=vec3(position.x*wd,aBar.z+position.y*aBar.w,position.z*wd);
      vC=aColor; vN=normal; gl_Position=projectionMatrix*viewMatrix*vec4(aBar.x+p.x,p.y,aBar.y+p.z,1.0); }`,
  fragmentShader:`uniform vec3 L; varying vec3 vC; varying vec3 vN; void main(){ gl_FragColor=vec4(vC*(0.7+0.3*max(dot(normalize(vN),normalize(L)),0.0)),1.0); }`});
const barOutMat=new THREE.ShaderMaterial({
  uniforms:{mpp:U.mpp,w:U.w,c:{value:INK}},
  vertexShader:`attribute vec4 aBar; attribute float aW; uniform float mpp,w;
    void main(){ if(aBar.w<0.01){ gl_Position=vec4(2.0,2.0,2.0,1.0); return; } float o=w*0.5, wd=max(aW,mpp*5.0)+2.0*o;
      vec3 p=vec3(position.x*wd,aBar.z-o+position.y*(aBar.w+2.0*o),position.z*wd); gl_Position=projectionMatrix*viewMatrix*vec4(aBar.x+p.x,p.y,aBar.y+p.z,1.0); }`,
  fragmentShader:`uniform vec3 c; void main(){ gl_FragColor=vec4(c,1.0); }`, side:THREE.BackSide});
const BAR_M=0.7;   // metros de barra por bici
const COL_MEC=new THREE.Color(0xc8402a), COL_ELE=new THREE.Color(0x4f7fa0), COL_BASE=new THREE.Color(0x6b5440), COL_OFF=new THREE.Color(0xb0a698);
let bars=null, BIKE=null;
function buildBars(d){
  const st=d.estaciones, n=st.length*3;
  if(!bars||bars.n<n){
    if(bars) bikeGroup.remove(bars.m,bars.o);
    const box=new THREE.BoxGeometry(1,1,1).translate(0,0.5,0);
    const aBar=new THREE.InstancedBufferAttribute(new Float32Array(n*4),4), aW=new THREE.InstancedBufferAttribute(new Float32Array(n),1), aColor=new THREE.InstancedBufferAttribute(new Float32Array(n*3),3);
    const g=instGeo(box,{aBar,aW,aColor}), go=instGeo(box,{aBar,aW});
    const m=new THREE.Mesh(g,barMat), o=new THREE.Mesh(go,barOutMat); m.frustumCulled=o.frustumCulled=false; bikeGroup.add(m,o);
    bars={n,m,o,g,go,aBar,aW,aColor};
  }
  const B=bars.aBar.array, W=bars.aW.array, Cc=bars.aColor.array; let k=0;
  const put=(x,z,y0,h,w,c)=>{ B[k*4]=x; B[k*4+1]=z; B[k*4+2]=y0; B[k*4+3]=h; W[k]=w; Cc[k*3]=c.r; Cc[k*3+1]=c.g; Cc[k*3+2]=c.b; k++; };
  for(const [,x,z,,mec,ele,,act] of st){ const hm=mec*BAR_M, he=ele*BAR_M;
    put(x,z,0.3,0.5,2.6,act?COL_BASE:COL_OFF); put(x,z,0.8,act?hm:0,1.6,COL_MEC); put(x,z,0.8+hm,act?he:0,1.6,COL_ELE); }
  bars.g.instanceCount=bars.go.instanceCount=k;
  bars.aBar.needsUpdate=bars.aW.needsUpdate=bars.aColor.needsUpdate=true;
}

/* ================= Tiempo visual: nubes, lluvia, nieve, niebla, tormenta, noche ================= */
// Dos pasadas a pantalla completa (baratas): una multiplica (sombras de nubes tramadas, lluvia a plumilla, noche,
// luz de atardecer) y otra mezcla (niebla, nieve, relámpagos). Las nubes están ancladas al suelo y viajan con el viento real.
const sstep=(a,b,x)=>{ const t=Math.min(1,Math.max(0,(x-a)/(b-a))); return t*t*(3-2*t); };
function sunElev(d){                                                        // altura del sol en Barcelona (grados)
  const rad=Math.PI/180, y0=Date.UTC(d.getUTCFullYear(),0,0), day=(d.getTime()-y0)/864e5;
  const g=2*Math.PI/365*(day-1);
  const decl=0.006918-0.399912*Math.cos(g)+0.070257*Math.sin(g)-0.006758*Math.cos(2*g)+0.000907*Math.sin(2*g)-0.002697*Math.cos(3*g)+0.00148*Math.sin(3*g);
  const eqt=229.18*(0.000075+0.001868*Math.cos(g)-0.032077*Math.sin(g)-0.014615*Math.cos(2*g)-0.040849*Math.sin(2*g));
  const tst=d.getUTCHours()*60+d.getUTCMinutes()+d.getUTCSeconds()/60+eqt+4*2.1686, ha=(tst/4-180)*rad, lat=41.3874*rad;
  return Math.asin(Math.sin(lat)*Math.sin(decl)+Math.cos(lat)*Math.cos(decl)*Math.cos(ha))/rad; }
const WX_SIMS={real:{n:['tiempo real','real weather']},
  sol:{n:['simular: sol (de día)','simulate: sunny (daytime)'],d:{codigo:0,nubes:0,precipitacion_mm:0,lluvia_mm:0,viento_kmh:12,viento_dir:270},elev:45},
  nublado:{n:['simular: nubes y viento (de día)','simulate: clouds and wind (daytime)'],d:{codigo:3,nubes:85,viento_kmh:30,viento_dir:290},elev:40},
  lluvia:{n:['simular: lluvia (de día)','simulate: rain (daytime)'],d:{codigo:63,nubes:100,precipitacion_mm:2.5,lluvia_mm:2.5,viento_kmh:20,viento_dir:230},elev:40},
  tormenta:{n:['simular: tormenta (de día)','simulate: thunderstorm (daytime)'],d:{codigo:95,nubes:100,precipitacion_mm:9,lluvia_mm:9,viento_kmh:55,viento_dir:200},elev:40},
  niebla:{n:['simular: niebla (de día)','simulate: fog (daytime)'],d:{codigo:45,nubes:100,viento_kmh:5,viento_dir:90},elev:40},
  nieve:{n:['simular: nieve (de día)','simulate: snow (daytime)'],d:{codigo:73,nubes:100,precipitacion_mm:1.5,viento_kmh:12,viento_dir:0},elev:40},
  atardecer:{n:['simular: atardecer','simulate: sunset'],elev:2},
  noche:{n:['simular: noche','simulate: night'],elev:-25}};
// Descripción del tiempo por código WMO (la de Open-Meteo que guarda vivo.py está en español)
function wmoTxt(c){ c=c||0;
  const W=c===0?['despejado','clear sky']:c<=2?['algunas nubes','partly cloudy']:c===3?['cubierto','overcast']:c<=48?['niebla','fog']:c<=57?['llovizna','drizzle']
    :c<=67?['lluvia','rain']:c<=77?['nieve','snow']:c<=82?['chubascos','rain showers']:c<=86?['chubascos de nieve','snow showers']:['tormenta','thunderstorm'];
  return TX(W[0],W[1]); }
let wxSim=(()=>{ try{ const v=localStorage.getItem('vivo.wxsim'); return WX_SIMS[v]?v:'real'; }catch(e){ return 'real'; } })();
ON.tiempo=store.get('tiempo',true);
const WXV={cloud:0,rain:0,snow:0,fog:0,storm:0,dark:0,golden:0,sway:0,lights:0};
let wxT=null, wxOff=new THREE.Vector2(Math.random()*5e4,Math.random()*5e4), wxLast=0, flashV=0, nextFlash=0, flashT=-9;
function wxTarget(){
  const S=WX_SIMS[wxSim]||{}, d=Object.assign({codigo:0,nubes:15,viento_kmh:8,viento_dir:270},WX||{},S.d||{});
  const c=d.codigo||0, mm=d.precipitacion_mm||d.lluvia_mm||0;
  const isRain=(c>=51&&c<=67)||(c>=80&&c<=82)||c>=95, isSnow=(c>=71&&c<=77)||c===85||c===86, isFog=c===45||c===48;
  const elev=S.elev!==undefined?S.elev:sunElev(new Date());
  // con niebla, cielo cubierto liso: el velo ya tapa las nubes (y su ruido es caro)
  return {cloud:isFog?1:Math.min(1,(d.nubes||0)/100), rain:isRain?Math.min(1,(c<=57?0.3:0.5)+mm/8):0, snow:isSnow?Math.min(1,0.45+mm/4):0,
    fog:isFog?1:0, storm:c>=95?1:0, dark:sstep(3,-9,elev), golden:sstep(-5,1,elev)*(1-sstep(4,16,elev)),
    lights:Math.max(sstep(-0.5,-6,elev),isFog?0.85:0,isSnow?0.75:0,c>=95?0.6:0,isRain?0.3*Math.min(1,(d.nubes||0)/100):0),
    sway:sstep(8,60,d.viento_kmh||0)*0.7, wind:d.viento_kmh||0, wdir:d.viento_dir||0, elev, desc:d.descripcion||WX&&WX.descripcion||''}; }
const WX_GLSL=`uniform mat4 invPV; uniform float dpr; varying vec2 vN; ${NOISE}
  vec2 ground(){ vec4 a=invPV*vec4(vN,-1.,1.), b=invPV*vec4(vN,1.,1.); a/=a.w; b/=b.w; float t=a.y/(a.y-b.y); return mix(a.xz,b.xz,clamp(t,0.,1.)); }
  float fbm(vec2 p){ float s=0.,a=.5; for(int i=0;i<4;i++){ s+=a*noise(p); p=p*2.03+vec2(17.3,9.1); a*=.5; } return s; }
    float streaks(vec2 p,float ang,float t,float dens,float cw,float ch,float len,float speed){
      float s=sin(ang), c=cos(ang); vec2 q=vec2(c*p.x+s*p.y,-s*p.x+c*p.y); q.y+=t*speed;
      vec2 id=floor(q/vec2(cw,ch)), f=q-id*vec2(cw,ch); if(hash(id)>dens) return 0.;
      float x0=cw*(0.15+0.7*hash(id+3.1)), y0=(ch-len)*hash(id+7.7), dy=f.y-y0;
      return step(0.,dy)*step(dy,len)*(1.-smoothstep(0.7,1.7,abs(f.x-x0)))*(0.6+0.4*hash(id+1.3)); }`;
const WX_V=`varying vec2 vN; void main(){ vN=position.xy; gl_Position=vec4(position.xy,0.,1.); }`;
const wxMul=new THREE.ShaderMaterial({ transparent:true, depthTest:false, depthWrite:false,
  blending:THREE.CustomBlending, blendEquation:THREE.AddEquation, blendSrc:THREE.DstColorFactor, blendDst:THREE.ZeroFactor,
  uniforms:{invPV:{value:new THREE.Matrix4()},dpr:{value:1},time:{value:0},off:{value:wxOff},snow:{value:0},cloud:{value:0},dark:{value:0},golden:{value:0},
    rain:{value:0},slant:{value:0},sp:U.sp,hatchOn:U.hatchOn,ink:{value:INK},lmL:{value:Array.from({length:32},()=>new THREE.Vector4(0,0,0,0))},lit:{value:0}},
  vertexShader:WX_V,
  fragmentShader:`uniform float time,cloud,dark,golden,rain,snow,slant,sp,hatchOn,lit; uniform vec2 off; uniform vec3 ink; uniform vec4 lmL[32]; ${WX_GLSL} ${HATCH}
    void main(){ vec3 m=vec3(1.);
      // Solo se compila lo que hace falta (W_NUBES, W_FOCOS): en la gráfica integrada (Direct3D vía ANGLE) los if
      // se ejecutan enteros aunque no se cumplan, y el ruido de las nubes y el bucle de focos costaban ~12 ms por fotograma
      #ifdef W_NUBES
      if(cloud>0.96){ m*=vec3(0.86,0.84,0.83)*(1.-0.05*cloud); }
      else { vec2 w=ground(); float n=fbm((w+off)/1500.);
        float thr=mix(0.80,0.30,cloud), c=smoothstep(thr,thr+0.14,n)*min(1.,cloud*1.8);
        float h=hatchOn>0.5?hatch(w,0.785,0.11,sp*1.15):0.;
        m*=mix(vec3(1.),vec3(0.82,0.79,0.77),c); m=mix(m,m*ink*2.0,h*c*0.45); m*=1.-0.05*cloud; }
      #else
      m*=vec3(0.86,0.84,0.83)*(1.-0.05*cloud)*step(0.01,cloud)+vec3(1.-step(0.01,cloud));   // cubierto (o nada): un tinte plano
      #endif
      m*=mix(vec3(1.),vec3(1.,0.84,0.66),golden*0.5);
      float fl=0.;                                                            // monumentos con focos: su fachada y su entorno no se apagan
      #ifdef W_FOCOS
      { vec2 w=ground(); for(int i=0;i<W_FOCOS;i++){ vec4 l=lmL[i]; fl=max(fl,smoothstep(l.z,l.z*0.45,distance(w,l.xy))); } fl*=lit; }   // solo los monumentos en pantalla
      #endif
      m*=mix(vec3(1.),vec3(0.60,0.64,0.80),dark*0.85*(1.-fl*0.9));
      m*=mix(vec3(1.),vec3(1.,0.93,0.80),fl*dark*0.6);
      if(rain>0.01) m*=mix(vec3(1.),vec3(0.86,0.87,0.90),rain);
      if(snow>0.01){ float g=dot(m,vec3(0.333)); m=mix(m,vec3(g),snow*0.5); }              // todo más apagado y húmedo
      gl_FragColor=vec4(m,1.); }`,
  extensions:{derivatives:true}});
function wxTex(draw){ const c=document.createElement('canvas'); c.width=256; c.height=512; const g=c.getContext('2d');
  g.fillStyle='#000'; g.fillRect(0,0,256,512); g.fillStyle=g.strokeStyle='#fff'; draw(g,c);
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.minFilter=t.magFilter=THREE.LinearFilter; t.generateMipmaps=false; return t; }
const rainTex=wxTex(g=>{ let r=7; const rnd=()=>(r=(r*16807)%2147483647)/2147483647;      // trazos verticales que se repiten sin costuras
  for(let i=0;i<46;i++){ const x=rnd()*256, y=rnd()*512, L=22+rnd()*26; g.globalAlpha=0.55+0.45*rnd(); g.lineWidth=1.1+rnd()*0.6;
    for(const dx of [0,-256,256]) for(const dy of [0,-512,512]){ g.beginPath(); g.moveTo(x+dx,y+dy); g.lineTo(x+dx,y+dy+L); g.stroke(); } } });
const snowTex=wxTex(g=>{ let r=11; const rnd=()=>(r=(r*16807)%2147483647)/2147483647;
  for(let i=0;i<70;i++){ const x=rnd()*256, y=rnd()*512, R=1.3+rnd()*2.2; g.globalAlpha=0.6+0.4*rnd();
    for(const dx of [0,-256,256]) for(const dy of [0,-512,512]){ g.beginPath(); g.arc(x+dx,y+dy,R,0,6.2832); g.fill(); } } });
const wxMix=new THREE.ShaderMaterial({ transparent:true, depthTest:false, depthWrite:false,
  uniforms:{invPV:wxMul.uniforms.invPV,dpr:wxMul.uniforms.dpr,time:wxMul.uniforms.time,slant:wxMul.uniforms.slant,rain:wxMul.uniforms.rain,fog:{value:0},snow:{value:0},flash:{value:0},rainTex:{value:rainTex},snowTex:{value:snowTex},
    paper:{value:new THREE.Color(0xefe1c2)}},
  vertexShader:WX_V,
  fragmentShader:`uniform float time,slant,fog,snow,flash,rain; uniform vec3 paper; uniform sampler2D rainTex,snowTex; ${WX_GLSL}
    float flakes(vec2 p,float t,float sc,float sp,float r,float seed){
      vec2 q=p+vec2(sin(t*0.8+p.y*0.013+seed)*7.+slant*t*80.,t*sp); vec2 id=floor(q/sc), f=q-id*sc;
      if(hash(id+seed)>0.62) return 0.; vec2 c=sc*vec2(0.2+0.6*hash(id+2.+seed),0.2+0.6*hash(id+4.+seed));
      return 1.-smoothstep(r*0.4,r,length(f-c)); }
    void main(){ float a=0.; vec3 col=paper;
      #ifdef W_NIEBLA
      { vec2 w=ground(); float n=fbm(w/700.+vec2(time*0.012,time*0.004)); a=fog*(0.28+0.30*(vN.y*0.5+0.5)+0.30*n); }
      #endif
      #ifdef W_NIEVE
      { vec2 p=gl_FragCoord.xy/dpr;
        vec2 q1=p+vec2(sin(time*0.7+p.y*0.012)*7.+slant*time*80.,time*46.), q2=p*1.55+vec2(sin(time*0.9+p.y*0.02+2.)*5.+slant*time*60.,time*48.);
        float f=max(texture2D(snowTex,q1/vec2(256.,512.)).r,0.8*texture2D(snowTex,q2/vec2(256.,512.)+0.37).r);
        a=max(a,f*snow*0.95); col=mix(col,vec3(1.,0.99,0.97),f); }
      #endif
      #ifdef W_LLUVIA
      { vec2 p=gl_FragCoord.xy/dpr;
        float sn=sin(slant), cs=cos(slant); vec2 q=vec2(cs*p.x+sn*p.y,-sn*p.x+cs*p.y);
        float s=texture2D(rainTex,(q+vec2(0.,time*1150.))/vec2(256.,512.)).r
               +0.6*texture2D(rainTex,(q*1.6+vec2(91.,time*1250.))/vec2(256.,512.)+0.5).r*step(0.5,rain);
        s=clamp(s,0.,1.)*(0.45+0.55*rain); a=max(a,s*0.85); col=mix(col,vec3(0.97,0.97,0.95),s); }
      #endif
      if(flash>0.){ a=max(a,flash*0.6); col=mix(col,vec3(1.),flash*0.5); }
      if(a<0.004) discard;
      gl_FragColor=vec4(col,clamp(a,0.,0.9)); }`});
/* --- Alumbrado: farolas a ambos lados de cada calle y focos en los monumentos; se encienden escalonadas al anochecer,
       con niebla, nieve o tormenta. Un único dibujado de puntos con brillo aditivo. --- */
const lampMat=new THREE.ShaderMaterial({ transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
  uniforms:{mpp:U.mpp,dpr:wxMul.uniforms.dpr,L:{value:0},fog:{value:0},night:{value:0}},
  vertexShader:`uniform float mpp,dpr,L,fog,night; attribute float aR; attribute float aRnd; attribute vec3 aC; varying float vA; varying float vK; varying vec3 vC;
    void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
      vA=smoothstep(aRnd*0.75,aRnd*0.75+0.12,L);                                // cada farola se enciende a su momento
      if(aR<12.&&aRnd>0.4+night) vA=0.;                                        // de día (niebla, nieve) basta con una parte
      float px=2.*aR*(1.+fog*0.5)/mpp; vK=clamp(px/10.,0.,1.); vC=aC;
      gl_PointSize=vA>0.001?clamp(px*0.8,2.2,aR>12.?120.:24.)*dpr:0.; }    // al 80 %: el borde del halo casi no se veía y era un tercio del relleno`,
  fragmentShader:`uniform float fog,night; varying float vA; varying float vK; varying vec3 vC;
    void main(){ float d0=length(gl_PointCoord-0.5)*2.; if(d0>1.) discard; float d=d0*0.8;   // d: distancia en el tamaño de antes
      float glow=exp(-d*d*(3.2-fog*1.4))*(0.62+0.25*fog)*(1.-smoothstep(0.7,1.,d0)), core=smoothstep(0.13,0.02,d)*vK;
      gl_FragColor=vec4(vC*(glow*(0.35+0.65*vK)+core)*vA*(0.22+0.78*night),1.); }`});   // de día (niebla, nieve) se notan poco
let lamps=null, nLamps=0, nLmLights=0;
function buildLamps(){
  const P=[], R=[], Rn=[], C=[], SP=[40,36,32,30,28,26,24,22], warm=[1.0,0.74,0.42], white=[1.0,0.9,0.72];
  const push=(x,y,z,r,rn,c)=>{ P.push(x,y,z); R.push(r); Rn.push(rn); C.push(c[0],c[1],c[2]); };
  for(const e of RED.E){ const c=e.c, n=c.length/2, sp=SP[e.cls]||28, half=e.lanes*(e.one?1:2)*1.6+2.2;
    let acc=sp*hash(c[0],c[1]);                                               // desfase para que no coincidan en los cruces
    for(let i=1;i<n;i++){ const x0=c[2*i-2], z0=c[2*i-1], dx=c[2*i]-x0, dz=c[2*i+1]-z0, L=Math.hypot(dx,dz); if(L<0.01) continue;
      const ux=dx/L, uz=dz/L;
      for(let t=acc;t<L;t+=sp){ const x=x0+ux*t, z=z0+uz*t, side=((t/sp)|0)%2?1:-1;   // al tresbolillo, como en el Eixample
        push(x-uz*half*side,6,z+ux*half*side,5,hash(x,z),warm); }
      acc=((acc-L)%sp+sp)%sp; } }
  nLamps=R.length;
  for(const lm of (K.LMS||[])){ const poly=lm.poly||[], H=lm.body_h||20, S=lm.spire_h||0;      // focos que iluminan las fachadas
    for(let i=0;i<poly.length;i+=Math.max(1,Math.round(poly.length/14))){ const [x,z]=poly[i];
      push(x,Math.max(6,H*0.35),z,16,0.02*hash(x,z),white); }
    push(lm.x,Math.max(10,H*0.7),lm.z,Math.max(30,Math.min(70,(S||H)*0.45)),0.01,white);
    if(S) push(lm.x,S*0.75,lm.z,28,0.01,white); }
  nLmLights=R.length-nLamps;
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(P,3)); g.setAttribute('aR',new THREE.Float32BufferAttribute(R,1));
  g.setAttribute('aRnd',new THREE.Float32BufferAttribute(Rn,1)); g.setAttribute('aC',new THREE.Float32BufferAttribute(C,3));
  lamps=new THREE.Points(g,lampMat); lamps.frustumCulled=false; lamps.renderOrder=995; root.add(lamps); }
const wxQuad=new THREE.PlaneGeometry(2,2);
const wxM1=new THREE.Mesh(wxQuad,wxMul), wxM2=new THREE.Mesh(wxQuad,wxMix);
wxM1.frustumCulled=wxM2.frustumCulled=false; wxM1.renderOrder=990; wxM2.renderOrder=991; wxM1.visible=wxM2.visible=false; root.add(wxM1,wxM2);
const _wa=new THREE.Vector3(), _wb=new THREE.Vector3();
function setDefs(mat,want){ const d={}; let key=''; for(const k in want) if(want[k]){ d[k]=want[k]===true?'':String(want[k]); key+=k+'='+d[k]+','; }
  if(mat.userData.defKey!==key){ mat.userData.defKey=key; mat.defines=d; mat.needsUpdate=true; } }
function wxStep(now,dt,mpp){
  if(!ON.tiempo){ wxM1.visible=wxM2.visible=false; if(lamps) lamps.visible=false; if(K.U.wind) K.U.wind.value.z=0; return false; }
  if(!wxT||now-(wxStep.tt||0)>5000){ wxT=wxTarget(); wxStep.tt=now; }
  let moving=false; const k=Math.min(1,dt*0.6);
  for(const key in WXV){ const d=wxT[key]-WXV[key]; if(Math.abs(d)>0.004){ WXV[key]+=d*k; moving=true; } else WXV[key]=wxT[key]; }
  // viento: hacia dónde sopla (la dirección meteorológica es de dónde viene); x = este, z = sur
  const to=(wxT.wdir+180)*Math.PI/180, wx=Math.sin(to), wz=-Math.cos(to), ms=wxT.wind/3.6;
  wxOff.x-=wx*ms*2.2*dt; wxOff.y-=wz*ms*2.2*dt;                           // las nubes van más rápido que el viento a ras de suelo
  const t=K.controls.target; _wa.set(t.x,0,t.z).project(K.cam); _wb.set(t.x+wx*50,0,t.z+wz*50).project(K.cam);
  const sx=_wb.x-_wa.x, sy=_wb.y-_wa.y, sl=Math.hypot(sx,sy)>1e-6?sx/Math.hypot(sx,sy):0;
  const u=wxMul.uniforms, v=wxMix.uniforms, time=now/1000;
  K.cam.updateMatrixWorld(); u.invPV.value.multiplyMatrices(K.cam.matrixWorld,K.cam.projectionMatrixInverse);
  u.dpr.value=K.renderer?K.renderer.getPixelRatio():Math.min(2,devicePixelRatio||1); u.time.value=time%600;
  u.cloud.value=WXV.cloud; u.dark.value=WXV.dark; u.golden.value=WXV.golden; u.rain.value=WXV.rain;
  u.slant.value=Math.max(-0.5,Math.min(0.5,sl*Math.min(1,wxT.wind/45)*0.55));
  // relámpagos en tormenta: doble destello cada 6–20 s
  if(WXV.storm>0.5){ if(!nextFlash) nextFlash=now+3000; if(now>nextFlash){ flashT=now; nextFlash=now+6000+Math.random()*14000; } }
  const fe=(now-flashT)/1000; flashV=fe<0.09?1:fe<0.18?0.15:fe<0.27?0.8:fe<0.6?Math.max(0,0.8*(1-(fe-0.27)/0.33)):0;
  v.fog.value=WXV.fog; v.snow.value=u.snow.value=WXV.snow; v.flash.value=flashV;
  wxM1.visible=WXV.cloud>0.01||WXV.dark>0.01||WXV.golden>0.01||WXV.rain>0.01||WXV.snow>0.01;
  wxM2.visible=WXV.fog>0.01||WXV.snow>0.01||WXV.rain>0.01||flashV>0;
  if(K.U.wind){ K.U.wind.value.set(wx,wz,WXV.sway,time); }
  if(WXV.lights>0.005){ if(!lamps&&RED) buildLamps(); else if(!RED&&redState==='none') loadRed(); }
  if(!wxStep.lm&&K.LMS){ wxStep.lm=K.LMS.map(l=>{ const a=l.axis||{}; return [l.x,l.z,Math.max(25,(Math.max(a.len||0,a.wid||0))*0.6+(l.spire_h||l.body_h||20)*0.9)]; }); }
  u.lit.value=WXV.lights;
  // focos de monumentos: al shader solo van los que tocan la pantalla (antes repasaba los 32 en cada píxel)
  let nFocos=0;
  if(WXV.lights>0.01&&WXV.dark>0.01&&wxStep.lm){
    const cam=K.cam, hh=(cam.top-cam.bottom)/cam.zoom/2, hw=(cam.right-cam.left)/cam.zoom/2, Rv=Math.max(hw,hh/Math.max(0.35,Math.cos(K.controls.getPolarAngle())))*1.2;
    for(const [x,z,r] of wxStep.lm){ if(nFocos>=32) break; if(Math.hypot(x-t.x,z-t.z)<Rv+r) u.lmL.value[nFocos++].set(x,z,r,1); } }
  const nF=nFocos?[1,2,4,8,16,32].find(n=>n>=nFocos):0;
  for(let i=nFocos;i<nF;i++) u.lmL.value[i].set(0,0,0.001,0);      // huecos: radio casi nulo, no iluminan
  // versión del shader con solo lo necesario (cada combinación se compila una vez y se reutiliza)
  setDefs(wxMul,{W_NUBES:WXV.cloud>0.01&&WXV.cloud<=0.96, W_FOCOS:nF});
  setDefs(wxMix,{W_NIEBLA:WXV.fog>0.01, W_NIEVE:WXV.snow>0.01, W_LLUVIA:WXV.rain>0.01});
  if(lamps){ lamps.visible=WXV.lights>0.005; lampMat.uniforms.L.value=WXV.lights; lampMat.uniforms.fog.value=Math.max(WXV.fog,WXV.snow*0.5); lampMat.uniforms.night.value=Math.max(WXV.dark,WXV.storm*0.4); }
  // repintado: lluvia, nieve y relámpagos a 60 fps; nubes y árboles mecidos, a 12–30 fps (el resto del tiempo el visor descansa)
  const fast=WXV.rain>0.01||WXV.snow>0.01||flashV>0||moving, sway=WXV.sway>0.05&&mpp<1.3, slow=WXV.cloud>0.05||WXV.fog>0.01;
  const iv=fast?0:sway?33:slow?80:Infinity;
  if(now-wxLast>=iv){ wxLast=now; return true; }
  return false;
}
// Botón «Clima» (arriba, junto a los modos): fuerza un tiempo para probar o enseñar el visor
const WX_BTN=[['real','Real','Real'],['sol','Sol','Sun'],['nublado','Nublado','Cloudy'],['lluvia','Lluvia','Rain'],['nieve','Nieve','Snow'],null,
  ['tormenta','Tormenta','Storm'],['niebla','Niebla','Fog'],['atardecer','Atardecer','Sunset'],['noche','Noche','Night']];
const wxBtn=document.createElement('button'), wxPop=document.createElement('div');
wxBtn.innerHTML='<svg class="ico" viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11.2 3.5 3.5 0 0 0 7 18z"/></svg><span class="lbl"></span>';
wxPop.className='card'; wxPop.style.cssText='position:fixed;display:none;z-index:4;padding:6px;gap:4px;flex-wrap:wrap;max-width:min(300px,calc(100vw - 16px))';
function setWxSim(k){ wxSim=WX_SIMS[k]?k:'real'; try{ localStorage.setItem('vivo.wxsim',wxSim); }catch(_){} wxT=null; wxUI(); K.dirty(); panel(); }
function wxUI(){ const it=WX_BTN.find(x=>x&&x[0]===wxSim), nom=it?TX(it[1],it[2]):wxSim;
  const t=wxSim==='real'?TX('Clima: real','Weather: live'):TX('Clima forzado: ','Forced weather: ')+nom;
  wxBtn.lastElementChild.textContent=t; wxBtn.setAttribute('aria-label',t); wxBtn.setAttribute('aria-pressed',wxSim==='real'?'false':'true');
  wxBtn.title=TX('Forzar el tiempo: sol, nublado, lluvia, nieve…','Force the weather: sun, clouds, rain, snow…');
  wxPop.innerHTML=WX_BTN.map(x=>x?`<button data-wx="${x[0]}" aria-pressed="${x[0]===wxSim}" style="font-size:15px;padding:6px 11px">${TX(x[1],x[2])}</button>`:'<div style="flex-basis:100%;height:0;border-top:1px solid rgba(58,38,22,.2);margin:2px 0"></div>').join('');
  ON.tiempo=true; store.set('tiempo',true); }
wxBtn.onclick=e=>{ e.stopPropagation(); if(wxPop.style.display==='flex'){ wxPop.style.display='none'; return; }
  const r=wxBtn.getBoundingClientRect(); wxPop.style.display='flex';
  if(r.left>innerWidth*0.6&&r.width<60){                                         // barra lateral del móvil: el menú, a su izquierda
    wxPop.style.left=''; wxPop.style.right=(innerWidth-r.left+8)+'px'; wxPop.style.top=Math.max(8,Math.min(innerHeight-wxPop.offsetHeight-8,r.top))+'px'; }
  else{ wxPop.style.right=''; wxPop.style.top=(r.bottom+6)+'px'; wxPop.style.left=Math.max(8,Math.min(innerWidth-wxPop.offsetWidth-8,r.left))+'px'; } };
wxPop.onclick=e=>{ const k=e.target.dataset&&e.target.dataset.wx; if(!k) return; e.stopPropagation(); setWxSim(k); wxPop.style.display='none'; };
document.addEventListener('pointerdown',e=>{ if(wxPop.style.display==='flex'&&!wxPop.contains(e.target)&&e.target!==wxBtn) wxPop.style.display='none'; });
{ const tools=document.querySelector('.tools'), lang=document.getElementById('bLang'); if(tools) tools.insertBefore(wxBtn,lang&&lang.parentNode===tools?lang:null); else { wxBtn.style.cssText='position:fixed;top:12px;right:12px;z-index:3'; document.body.appendChild(wxBtn); } document.body.appendChild(wxPop); }
wxUI(); if(wxSim==='real') ON.tiempo=store.get('tiempo',true);
function wxLine(){
  if(!wxT) wxT=wxTarget(); const T=wxT, en=window.LANG==='en';
  const dirs=en?['N','NE','E','SE','S','SW','W','NW']:['N','NE','E','SE','S','SO','O','NO'], hacia=dirs[Math.round(((T.wdir+180)%360)/45)%8];
  const cielo=T.fog?TX('niebla','fog'):T.snow?TX('nevando','snowing'):T.storm?TX('tormenta','thunderstorm'):T.rain?TX('lloviendo','raining'):T.cloud>0.85?TX('cubierto','overcast')
    :T.cloud>0.4?TX('nubes y claros','sun and clouds'):T.cloud>0.1?TX('algunas nubes','a few clouds'):TX('despejado','clear');
  const luz=(T.elev<-6?TX('noche','night'):T.elev<0?TX('crepúsculo','twilight'):T.elev<8?TX('sol bajo','low sun'):TX('de día','daytime'))
    +(T.lights>0.05?(lamps?TX(` · ${NUM(nLamps)} farolas y ${nLmLights} focos encendidos`,` · ${NUM(nLamps)} street lights and ${nLmLights} floodlights on`):TX(' · alumbrado encendido',' · street lights on')):'');
  const opts=Object.entries(WX_SIMS).map(([k,s])=>`<option value="${k}" ${k===wxSim?'selected':''}>${TX(s.n[0],s.n[1])}</option>`).join('');
  return `${cielo} · ${luz} (${TX('sol a','sun at')} ${Math.round(T.elev)}°) · ${TX('nubes y lluvia empujadas por el viento hacia el','clouds and rain pushed by the wind towards the')} ${hacia}`
    +`<br><select id="wxSim" style="font-size:13px;padding:2px 3px;margin-top:3px;max-width:100%">${opts}</select>${wxSim!=='real'?` <b>${TX('simulación','simulation')}</b>`:''}`; }

/* ================= Manejadores de capas (añadir aquí bus, metro real, personas…) ================= */
let WX=null;
const H={
  trafico:d=>{ TRAF=new Map(d.tramos.map(r=>[r[0],r[1]])); candDirty=true; if(tramosState==='none') loadTramos(); else recolor(); },
  bicing:d=>{ const primero=!BIKE; BIKE=d; buildBars(d); if(BK){ queueBikeEvents(d); if(primero) warmStart(); } },   // red ciclista antes que Bicing: arranque en caliente aquí
  tiempo:d=>{ WX=d; wxT=null; },
  bus:d=>{ BUSDELAY=d.lineas||{}; BUSDELAY_INFO=d; busLastScan=0; },
};

/* ================= Fuentes directas: la web pública, sin colector ================= */
// Sin manifest.json (no hay colector, como en la web publicada), el navegador pide él mismo Bicing, el tráfico y el
// tiempo a sus fuentes públicas (las tres permiten CORS) y los deja en el mismo formato que escribe pipeline/vivo.py.
// El retraso real de los buses necesita las claves de TMB, que no pueden ir en una página pública: siguen su horario.
const ORI=K.origin||[429020,4583460];
function utm31(lon,lat){                                                     // como pipeline/geo.py (Krüger, GRS80, huso 31)
  const A=6378137, F=1/298.257222101, K0=0.9996, E2=F*(2-F), EP2=E2/(1-E2), L0=3*Math.PI/180, r=Math.PI/180;
  const phi=lat*r, lam=lon*r, s=Math.sin(phi), c=Math.cos(phi), n=A/Math.sqrt(1-E2*s*s), t=Math.tan(phi)**2, cc=EP2*c*c, a=c*(lam-L0);
  const e4=E2*E2, e6=e4*E2;
  const m=A*((1-E2/4-3*e4/64-5*e6/256)*phi-(3*E2/8+3*e4/32+45*e6/1024)*Math.sin(2*phi)+(15*e4/256+45*e6/1024)*Math.sin(4*phi)-(35*e6/3072)*Math.sin(6*phi));
  const x=K0*n*(a+(1-t+cc)*a**3/6+(5-18*t+t*t+72*cc-58*EP2)*a**5/120)+500000;
  const y=K0*(m+n*Math.tan(phi)*(a*a/2+(5-t+9*cc+4*cc*cc)*a**4/24+(61-58*t+t*t+600*cc-330*EP2)*a**6/720));
  return [x,y]; }
const aLocal=(lon,lat)=>{ const [x,y]=utm31(lon,lat); return [Math.round((x-ORI[0])*10)/10,Math.round(-(y-ORI[1])*10)/10]; };
async function pedirTxt(u){ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); }
const WMO_ES={0:'despejado',1:'casi despejado',2:'parcialmente nublado',3:'cubierto',45:'niebla',48:'niebla',51:'llovizna',53:'llovizna',55:'llovizna intensa',
  61:'lluvia débil',63:'lluvia',65:'lluvia fuerte',80:'chubascos',81:'chubascos',82:'chubascos fuertes',95:'tormenta',96:'tormenta con granizo',99:'tormenta con granizo',71:'nieve',73:'nieve',75:'nieve fuerte'};
const BKD={feeds:null,info:null,infoTs:0,ele:new Set(),prev:null};
function electricas(s){ const t=s.num_bikes_available_types;
  if(t&&!Array.isArray(t)&&typeof t==='object') return +(t.ebike??t.electric??0)||0;
  if(Array.isArray(t)){ let n=0; for(const d of t) for(const [k,v] of Object.entries(d)){ const l=k.toLowerCase(); if(l.includes('e')&&l.includes('bike')&&l!=='mechanical') n+=+v||0; } return n; }
  let n=0; for(const v of (s.vehicle_types_available||[])){ const id=String(v.vehicle_type_id||''); if(BKD.ele.has(id)||/ebike|electric/i.test(id)) n+=+v.count||0; } return n; }
const DIRECTO={
  bicing:{cada:60,desc:'Bicis mecánicas y eléctricas y anclajes libres por estación',async leer(){
    if(!BKD.feeds){ const d=JSON.parse(await pedirTxt('https://api.citybik.es/gbfs/2/bicing/gbfs.json')).data; BKD.feeds=Object.fromEntries(Object.values(d)[0].feeds.map(f=>[f.name,f.url])); }
    if(!BKD.info||Date.now()-BKD.infoTs>6*3600e3){
      BKD.info=new Map(JSON.parse(await pedirTxt(BKD.feeds.station_information)).data.stations.map(s=>[String(s.station_id),s])); BKD.infoTs=Date.now();
      if(BKD.feeds.vehicle_types) try{ BKD.ele=new Set(JSON.parse(await pedirTxt(BKD.feeds.vehicle_types)).data.vehicle_types.filter(v=>(v.propulsion_type||'human')!=='human').map(v=>String(v.vehicle_type_id))); }catch(e){} }
    const act=[];
    for(const s of JSON.parse(await pedirTxt(BKD.feeds.station_status)).data.stations){ const inf=BKD.info.get(String(s.station_id)); if(!inf) continue;
      const [x,z]=aLocal(+inf.lon,+inf.lat), tot=+s.num_bikes_available||0, ele=Math.min(tot,electricas(s));
      act.push([String(s.station_id),x,z,+inf.capacity||0,tot-ele,ele,+s.num_docks_available||0,((s.is_renting??1)&&(s.is_installed??1))?1:0]); }
    const ev=[]; if(BKD.prev){ const antes=new Map(BKD.prev.map(r=>[r[0],r]));                   // bicis cogidas y dejadas desde la anterior
      for(const r of act){ const p=antes.get(r[0]); if(!p) continue; if(r[4]!==p[4]) ev.push([r[0],r[4]-p[4],'mecanica']); if(r[5]!==p[5]) ev.push([r[0],r[5]-p[5],'electrica']); } }
    BKD.prev=act; const sum=i=>act.reduce((s,r)=>s+r[i],0);
    return {estaciones:act,eventos:ev,totales:{estaciones:act.length,mecanicas:sum(4),electricas:sum(5),
      cogidas:ev.reduce((s,e)=>s+(e[1]<0?-e[1]:0),0),dejadas:ev.reduce((s,e)=>s+(e[1]>0?e[1]:0),0)}}; }},
  trafico:{cada:300,desc:'Estado actual y previsto a 15 min de cada tramo viario',async leer(){
    const tramos=[];
    for(const l of (await pedirTxt('https://opendata-ajuntament.barcelona.cat/data/dataset/8319c2b1-4c21-4962-9acd-6db4c5ff1148/resource/2d456eb5-4ea6-4f68-9794-2f3f1a58a933/download')).split(/\r?\n/)){
      const p=l.trim().split('#'); if(p.length<4||!/^\d+$/.test(p[0].trim())) continue; const a=parseInt(p[2],10), b=parseInt(p[3],10); if(isNaN(a)||isNaN(b)) continue;
      tramos.push([parseInt(p[0],10),a,b]); }
    if(!tramos.length) throw new Error(TX('formato inesperado','unexpected format'));
    return {tramos}; }},
  tiempo:{cada:900,desc:'Temperatura, lluvia, viento y nubosidad',async leer(){
    const d=JSON.parse(await pedirTxt('https://api.open-meteo.com/v1/forecast?latitude=41.3874&longitude=2.1686&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day&timezone=Europe%2FMadrid')).current;
    return {hora_dato:d.time,temperatura:d.temperature_2m,sensacion:d.apparent_temperature,humedad:d.relative_humidity_2m,precipitacion_mm:d.precipitation,lluvia_mm:d.rain,
      codigo:d.weather_code,nubes:d.cloud_cover,viento_kmh:d.wind_speed_10m,viento_dir:d.wind_direction_10m,es_dia:!!d.is_day,descripcion:WMO_ES[d.weather_code]||''}; }}};
// iBus: el Worker de la web (worker/index.js) guarda las previsiones de llegada en 25 paradas de control cada 2 min; aquí se
// compara cada una con la hora programada más cercana de esa línea en esa parada (como pipeline/vivo.py) y el retraso de
// cada línea es la mediana de los últimos 20 min. Sin el Worker (en casa, sin /api), los buses siguen solo su horario.
let IBX=null; const progCache=new Map();
const codParada=sid=>{ const p=String(sid).split('.'); return p.length>1?p[1]:p[0]; };   // "2.1314.683903" -> "1314"
function progDe(linea,codi){
  const key=linea+'|'+codi; let v=progCache.get(key); if(v) return v;
  if(!IBX){ IBX=new Map(); BUS.d.patrones.forEach((pat,pi)=>pat[6].forEach((sid,k)=>{ const c=codParada(sid); let l=IBX.get(c); if(!l) IBX.set(c,l=[]); l.push([pi,k]); })); }
  const pats=new Map(); for(const [pi,k] of (IBX.get(codi)||[])) if(String(BUS.d.lineas[BUS.d.patrones[pi][0]][0])===linea) pats.set(pi,k);
  v=[]; if(pats.size) for(const tr of BUS.trips){ const k=pats.get(tr.p); if(k!==undefined) v.push(tr.st+BUS.d.patrones[tr.p][5][k]*tr.du); }
  v.sort((a,b)=>a-b); progCache.set(key,v); return v; }
const mediana=a=>{ const b=a.slice().sort((x,y)=>x-y), m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
DIRECTO.bus={cada:120,desc:'Retraso real por línea: previsiones iBus de TMB frente al horario',async leer(){
  if(!BUS) throw new Error(TX('esperando el horario','waiting for the timetable'));
  const r=await fetch('/api/ibus',{cache:'no-store'}); if(r.status===404) return null;                // sin Worker: solo horario
  if(!r.ok) throw new Error('HTTP '+r.status);
  const d=await r.json(), ahora=Date.now()/1000, por={};
  if(!d.obs||!d.obs.length) return null;
  for(const [ts,codi,nom,cod,,lleg] of d.obs){
    if(ahora-ts>20*60) continue;
    const linea=[nom,cod].map(x=>x==null?null:String(x)).find(x=>x&&progDe(x,codi).length); if(!linea) continue;
    const m=madridDate(lleg*1000), t=m.getUTCHours()*3600+m.getUTCMinutes()*60+m.getUTCSeconds(), L=progDe(linea,codi);
    let lo=0,hi=L.length; while(lo<hi){ const mid=(lo+hi)>>1; if(L[mid]<t) lo=mid+1; else hi=mid; }
    const cerca=[L[lo-1],L[lo]].filter(x=>x!==undefined).reduce((a,b)=>Math.abs(b-t)<Math.abs(a-t)?b:a);
    const ret=t-cerca; if(Math.abs(ret)>20*60) continue;
    (por[linea]||(por[linea]=[])).push(ret); }
  const todos=Object.values(por).flat();
  return {lineas:Object.fromEntries(Object.entries(por).map(([l,v])=>[l,{retraso_s:Math.round(mediana(v)),n:v.length}])),
    retraso_medio_s:todos.length?Math.round(mediana(todos)):null,observaciones:todos.length,paradas_control:d.paradas_control,por_ciclo:d.por_ciclo}; }};
let directo=!window.LOCAL||/[?&]directo=1/.test(location.search);           // web pública (sin colector), o ?directo=1 para probarlo en casa
const dirNext={};
async function pollDirecto(){
  const capas=(manifest&&manifest.capas)||{}, now=Date.now();
  capas.bus=capas.bus||{estado:'simulado',descripcion:TX('Buses según el horario de TMB; el retraso real llega en cuanto hay previsiones de iBus','Buses follow the TMB timetable; real delays arrive as soon as there are iBus forecasts')};
  capas.metro=capas.metro||{estado:'simulado',descripcion:TX('Trenes según el horario de TMB','Trains follow the TMB timetable')};
  await Promise.all(Object.entries(DIRECTO).map(async([n,f])=>{
    if(now<(dirNext[n]||0)) return; dirNext[n]=now+f.cada*1000;
    try{ const v=await f.leer(); if(v===null) return;                         // fuente no disponible aquí (iBus sin Worker): se queda como está
      H[n](v); capas[n]={estado:'ok',ts:new Date().toISOString(),cada:f.cada,descripcion:f.desc}; K.dirty(); }
    catch(e){ console.warn('vivo directo:',n,e); dirNext[n]=now+Math.min(60000,f.cada*1000);       // reintento pronto
      capas[n]=Object.assign(capas[n]||{},{estado:'error',error:String(e&&e.message||e)}); } }));
  manifest={capas}; manifestErr=false;
}

/* ================= Sondeo del manifiesto ================= */
let manifest=null, manifestErr=false; const seen={};
async function poll(){
  if(directo){ await pollDirecto(); panel(); return; }
  try{
    const r=await fetch(VIVO+'manifest.json',{cache:'no-cache'}); if(!r.ok) throw new Error(r.status);
    manifest=await r.json(); manifestErr=false;
    for(const [n,c] of Object.entries(manifest.capas||{})){
      if(!H[n]||!c.archivo||!c.ts||seen[n]===c.ts) continue;
      try{ const rr=await fetch(VIVO+c.archivo,{cache:'no-cache'}); if(!rr.ok) continue; H[n](await rr.json()); seen[n]=c.ts; K.dirty(); }
      catch(e){ console.warn('vivo:',n,e); }
    }
  }catch(e){ manifest=null; manifestErr=true; directo=true; await pollDirecto(); }   // sin colector en casa: también directo
  panel();
}

/* ================= Panel ================= */
const css=document.createElement('style');
css.textContent=`#vivo{position:fixed;right:16px;bottom:70px;width:285px;padding:8px 12px;font-size:14px;line-height:1.35;z-index:2}
#vivo h3{margin:0 0 4px;font-family:"IM Fell English",serif;font-weight:400;font-size:18px;display:flex;justify-content:space-between;align-items:center}
#vivo h3 button{font-size:12px;padding:0 7px}
#vivo .row{display:flex;align-items:center;gap:6px;margin:3px 0}
#vivo .dot{width:8px;height:8px;border-radius:50%;flex:none}
#vivo .age{margin-left:auto;color:var(--muted,#6b5440);font-size:12px;white-space:nowrap}
#vivo .sub{color:var(--muted,#6b5440);font-size:12.5px;margin:-2px 0 3px 14px}
#vivo .wx{margin-top:5px;padding-top:5px;border-top:1px solid rgba(58,38,22,.2)}
#vivo .note{color:var(--muted,#6b5440);font-size:12px;margin-top:4px}
#vivo label{cursor:pointer;display:flex;align-items:center;gap:5px}
#vivo.min .body{display:none}
#vivo input[type=checkbox]{width:16px;height:16px}
/* Teléfono: hoja que sube desde abajo, cerrada hasta que se pulsa «En vivo» en la barra lateral */
@media (max-width:720px),(max-height:520px){
  #vivo{display:none;left:calc(8px + env(safe-area-inset-left));right:calc(64px + env(safe-area-inset-right));bottom:calc(8px + env(safe-area-inset-bottom));width:auto;
    max-height:min(62vh,calc(100vh - 90px));overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:15px;padding:8px 14px 12px;z-index:3}
  #vivo.abierto{display:block}
  #vivo.min .body{display:block}
  #vivo h3 button{font-size:20px;width:38px;height:34px;padding:0}
  #vivo .row{margin:7px 0} #vivo .sub{font-size:13.5px}
  #vivo input[type=checkbox]{width:20px;height:20px}
  #vivo select{font-size:15px!important;padding:5px!important}
}`;
document.head.appendChild(css);
const box=document.createElement('div'); box.id='vivo'; box.className='card'+(store.get('min',!!window.EMBED)?' min':'');   // incrustado: empieza plegado document.body.appendChild(box);
box.addEventListener('change',e=>{ if(e.target.id==='wxSim'){ e.target.blur(); setWxSim(e.target.value); return; }
  const k=e.target.dataset&&e.target.dataset.k; if(!k) return; ON[k]=e.target.checked; store.set(k,ON[k]); K.dirty(); panel(); });
const hoja=()=>getComputedStyle(K.LIVE_BTN||document.body).display!=='none'&&!!K.LIVE_BTN;   // ¿interfaz de teléfono?
box.addEventListener('click',e=>{ if(e.target.id!=='vivoMin') return;
  if(hoja()){ box.classList.remove('abierto'); if(K.LIVE_BTN) K.LIVE_BTN.setAttribute('aria-pressed','false'); return; }   // en el móvil, cierra la hoja
  box.classList.toggle('min'); store.set('min',box.classList.contains('min')); panel(); });
window.addEventListener('idioma',()=>{ wxUI(); panel(); hideBusLabels(); K.dirty(); });
const DOT={ok:'#6e9e5c',error:'#bf3a2a',simulado:'#d9a43a',pendiente:'#b0a698',sin_configurar:'#b0a698'};
function hace(ts){ if(!ts) return ''; const s=(Date.now()-new Date(ts).getTime())/1000; if(s<90) return TX('ahora','now');
  const v=s<3600?Math.round(s/60)+' min':s<86400?Math.round(s/3600)+' h':Math.round(s/86400)+' d'; return TX('hace '+v,v+' ago'); }
const NOMBRES={trafico:['Tráfico','Traffic'],vehiculos:['Vehículos','Vehicles'],bicing:['Bicing','Bicing'],tiempo:['Tiempo','Weather'],bus:['Buses TMB','TMB buses'],metro:['Metro','Metro'],personas:['Personas','People']};
const nombre=k=>TX(NOMBRES[k][0],NOMBRES[k][1]);
const ESTADO={ok:['ok','ok'],error:['error','error'],simulado:['simulado','simulated'],pendiente:['pendiente','pending'],sin_configurar:['sin configurar','not set up']};
function panel(){
  if(document.activeElement&&document.activeElement.id==='wxSim') return;     // no cerrar el desplegable mientras se usa
  const caps=(manifest&&manifest.capas)||{};
  const mpp=K.mppNow(), row=(k,detalle,toggle)=>{ const c=k==='personas'?{}:caps[k]||{}; const st=((k==='bus'&&BUS&&c.estado!=='ok')||(k==='metro'&&MET)||k==='personas')?'simulado':c.estado||(k==='vehiculos'?'simulado':'pendiente');
    const stale=c.ts&&c.cada&&(Date.now()-new Date(c.ts).getTime())/1000>c.cada*3;
    const label=toggle?`<label><input type="checkbox" data-k="${k}" ${ON[k]?'checked':''}>${nombre(k)}</label>`:nombre(k);
    const edad=c.ts?hace(c.ts):((k==='bus'&&BUS)||(k==='metro'&&MET))?TX('horario','timetable'):k==='personas'?TX('estimado','estimated'):(ESTADO[st]?TX(ESTADO[st][0],ESTADO[st][1]):st);
    return `<div class="row" title="${(c.descripcion||'')+(c.error?' · '+c.error:'')}"><span class="dot" style="background:${stale?'#d9a43a':DOT[st]||'#b0a698'}"></span>${label}<span class="age">${edad}</span></div>${detalle?`<div class="sub">${detalle}</div>`:''}`; };
  const pr=!ON.personas?'':mpp>=PED_MPP?TX('acércate para verlas · estimación: no hay datos abiertos de peatones','zoom in to see them · an estimate: there is no open pedestrian data'):
    TX(`${NUM(nPed)} personas cerca (${nPedWait} esperando para cruzar) · estimadas por tipo de calle y hora`,`${NUM(nPed)} people nearby (${nPedWait} waiting to cross) · estimated from street type and time of day`)
    +(WXV.rain>0.05||WXV.snow>0.05?TX(', menos por el mal tiempo',', fewer due to bad weather'):'');
  let tr='', bk='', vh='';
  if(caps.trafico&&caps.trafico.estado==='error') tr='error: '+caps.trafico.error;
  else if(TRAF){ let d=0,t=0; for(const s of TRAF.values()){ if(s>0) t++; if(s>=3&&s<=5) d++; } tr=TX(`${t} tramos con datos · ${d} densos o atascados`,`${t} road sections with data · ${d} heavy or jammed`); }
  if(!INC_DEMO) tr+=(tr?'<br>':'')+(incEstado==='ok'
    ?TX(`${INC_N} incidencias del Ayuntamiento · ${INCS.length} en el mapa`,`${INC_N} city traffic incidents · ${INCS.length} on the map`)
      +(INC_SIN.length?TX(` (${INC_SIN.length} sin sitio exacto)`,` (${INC_SIN.length} without an exact place)`):'')
    :TX('incidencias: ','incidents: ')+incEstado);
  if(BIKE){ const T=BIKE.totales||{}; bk=TX(`${NUM(T.mecanicas||0)} mecánicas · ${NUM(T.electricas||0)} eléctricas · ${T.estaciones||0} estaciones`,`${NUM(T.mecanicas||0)} mechanical · ${NUM(T.electricas||0)} electric · ${T.estaciones||0} stations`)
    +(T.cogidas||T.dejadas?TX(`<br>último minuto: ${T.cogidas||0} cogidas, ${T.dejadas||0} dejadas`,`<br>last minute: ${T.cogidas||0} taken, ${T.dejadas||0} returned`):'')
    +(bkState==='missing'&&LOADERR.bici==='404'?TX('<br>falta la red ciclista: ejecuta <b>python pipeline\\red_viaria.py</b>','<br>cycle network missing'):BK?TX(`<br>${nCyc} ciclistas cerca (salidas y llegadas reales, trayecto estimado)`,`<br>${nCyc} cyclists nearby (real departures and arrivals, estimated route)`):''); }
  else if(caps.bicing&&caps.bicing.estado==='error') bk='error: '+caps.bicing.error;
  if(redState==='missing') vh=LOADERR.red==='404'?TX('falta la red viaria: ejecuta <b>python pipeline\\red_viaria.py</b>','road network missing'):TX(`no se pudo cargar la red viaria (${LOADERR.red}) · reintentando…`,`could not load the road network (${LOADERR.red}) · retrying…`);
  else if(mpp>=VEH_MPP) vh=TX('acércate para verlos circular','zoom in to see them move');
  else if(redState==='loading') vh=TX('cargando la red viaria…','loading the road network…');
  else if(RED) vh=TX(`${NUM(nCars)} coches${BUS?'':` y ${nBuses} buses`} circulando (${nStopped} parados) · ${NUM(nParked)} aparcados · ${NUM(RED.nSig)} cruces con semáforo`,
                     `${NUM(nCars)} cars${BUS?'':` and ${nBuses} buses`} moving (${nStopped} stopped) · ${NUM(nParked)} parked · ${NUM(RED.nSig)} junctions with traffic lights`)
    +(PARK.size?'':TX(' (reejecuta suelo.py para verlos)',''))+(TRAF?TX(' · ritmo del tráfico real',' · pace of the real traffic'):TX(' · ritmo típico de esta hora',' · typical pace for this hour'));
  if(RED&&vh&&mpp<VEH_MPP&&window.LOCAL){ const t=K.controls.target, d=Math.hypot(t.x-area.x,t.z-area.z);     // depuración: solo en casa
    vh+=`<br><small>área ${Math.round(area.r)} m, a ${Math.round(d)} m de la vista · ${Math.round(performance.now()-lastStep)} ms desde el último paso · ${PARK.size} bloques de plazas</small>`; }
  if(simErr) vh+=`<br><b style="color:#bf3a2a">error: ${simErr.replace(/</g,'&lt;')}</b>`;
  const mt=MET?TX(`${nMetroAll} trenes en servicio ahora · ${MET.d.lineas.length} líneas · horario TMB`,`${nMetroAll} trains running now · ${MET.d.lineas.length} lines · TMB timetable`)+(K.mode==='under'?'':TX(' (abre «Subsuelo» para verlos)',' (open «Underground» to see them)'))
    :metState==='missing'&&LOADERR.metro==='404'?TX('falta el horario: ejecuta <b>python pipeline\\buses.py</b>','timetable missing'):TX('trenes simulados · se carga el horario real al abrir «Subsuelo»','simulated trains · the real timetable loads when you open «Underground»');
  let bs='';
  if(BUS){ const I=BUSDELAY_INFO, nl=BUSDELAY?Object.keys(BUSDELAY).length:0;
    const rm=I&&I.retraso_medio_s!=null?TX('retraso mediano ','median delay ')+`${I.retraso_medio_s>=0?'+':'−'}${Math.round(Math.abs(I.retraso_medio_s)/60)} min`:'';
    bs=TX(`${NUM(nBusAll)} en servicio ahora en toda la ciudad · ${nBuses} cerca · `,`${NUM(nBusAll)} running now across the city · ${nBuses} nearby · `)
      +(nl?TX(`${nl} de ${BUS.d.lineas.length} líneas con retraso real (iBus) · `,`${nl} of ${BUS.d.lineas.length} lines with real delay (iBus) · `)+rm
          :TX('horario TMB','TMB timetable')+(caps.bus&&caps.bus.estado==='error'?' · iBus: '+caps.bus.error:TX(' (sin retrasos reales todavía)',' (no real delays yet)'))); }
  else if(busState==='missing') bs=TX('falta el horario: ejecuta <b>python pipeline\\buses.py</b>','timetable missing');
  if(TRAM) bs+=TX(`<br>${nTramAll} tranvías en servicio ahora (horario TRAM) · ${nTram} cerca`,`<br>${nTramAll} trams running now (TRAM timetable) · ${nTram} nearby`)
    +(nTramWait?TX(` · ${nTramWait} esperando a que pase`,` · ${nTramWait} waiting for it to pass`):'');
  let wx='';
  if(WX){ const desc=window.LANG==='en'?wmoTxt(WX.codigo):(WX.descripcion||wmoTxt(WX.codigo));
    wx=`<div class="wx">${Math.round(WX.temperatura)} °C · ${desc} · ${TX('viento','wind')} ${Math.round(WX.viento_kmh)} km/h${WX.lluvia_mm?` · ${TX('lluvia','rain')} ${WX.lluvia_mm} mm`:''}</div>`; }
  const note=manifestErr?`<div class="note">${window.LOCAL?TX('Sin datos en vivo todavía. En otra ventana: <b>python pipeline\\vivo.py</b>','No live data yet. In another window: <b>python pipeline\\vivo.py</b>'):TX('Sin datos en vivo ahora mismo; se reintenta solo.','No live data right now; retrying automatically.')}</div>`:'';
  const cerrar=hoja()?'×':(box.classList.contains('min')?'+':'–');
  box.innerHTML=`<h3>${TX('En vivo','Live')} <button id="vivoMin" aria-label="${hoja()?TX('Cerrar','Close'):TX('Plegar','Collapse')}">${cerrar}</button></h3><div class="body">
    ${row('trafico',tr,true)}${row('vehiculos',vh,true)}${row('bicing',bk,true)}${row('tiempo',wxLine(),true)}
    ${row('bus',bs,false)}${row('metro',mt,false)}${row('personas',pr,true)}${wx}${note}</div>`;
}

/* ================= Incidencias de tráfico: pequeñas escenas animadas en la calle ================= */
// Cada tipo (obras, accidente, manifestación, calle cortada, avería) es un grupo de piezas con el mismo dibujo que los
// vehículos, balizas que parpadean (un único dibujado de puntos) y, de lejos, un aviso con su icono a tinta que late.
// La incidencia ocupa sus carriles: los coches hacen cola detrás (no la atraviesan) y evitan las calles cortadas.
// De momento solo en demostración: ?demo=incidencias pone una de cada tipo junto a Passeig de Gràcia.
const INC_DEMO=/[?&]demo=incidencias/.test(location.search);
const ORANGE=0xd9773a, GU_BLUE=0x3d5f9a;
function valla(){ const P=[...both(s=>[bx(-.05,.05,0,1.05,.06,0).translate(s*0.95,0,0),C.gray])];        // tanca de obra roja y blanca
  for(let i=0;i<6;i++) P.push([bx(-0.95+i*0.317,-0.95+(i+1)*0.317,.45,.95,.04),i%2?C.white:C.red]);
  return [...P,...both(s=>[bx(-.25,.25,0,.08,.3).translate(s*0.95,0,0),C.dark,.8])]; }
function cono(){ return [[new THREE.ConeGeometry(.17,.62,8).translate(0,.37,0),ORANGE],[new THREE.CylinderGeometry(.115,.135,.1,8).translate(0,.36,0),C.white],[bx(-.2,.2,0,.06,.4),C.dark,.8]]; }
function arena(){ return [[new THREE.ConeGeometry(1.2,.8,7).translate(0,.4,0),C.ochre,.9],[bx(-.9,.9,0,.5,.9).translate(1.6,0,.2),C.gray]]; }
function urbana(){ const W=1.8; return [...berlina(C.white), [bx(-2.36,2.36,.55,.72,W+.03),GU_BLUE], [bx(-.45,.35,1.48,1.62,1.25),C.dark,.8]]; }
function furgonUrbana(){ return [...furgoneta(C.white).filter(p=>p[1]!==C.ochre), [bx(-2.56,2.56,.6,.8,2.03),GU_BLUE], [bx(-.6,.4,2.5,2.64,1.3),C.dark,.8]]; }
function triangulo(){ return [[prof([[-.3,.06],[.3,.06],[0,.58]],.05),C.red],[prof([[-.17,.15],[.17,.15],[0,.45]],.06),C.white],[bx(-.2,.2,0,.06,.25),C.dark]]; }
function pancarta(){ return [...both(s=>[bx(-.03,.03,0,2.3,.05,0).translate(s*1.55,0,0),C.dark]), [bx(-1.5,1.5,1.35,2.2,.04),C.cream], [bx(-1.3,1.3,1.6,1.9,.05),C.wine,.9]]; }
function bandera(){ return [[bx(-.025,.025,0,2.6,.05),C.dark],[bx(.03,.95,1.95,2.55,.03),BODY]]; }
function desvio(){ return [[bx(-.04,.04,0,2.0,.06),C.gray],[new THREE.CylinderGeometry(.42,.42,.05,16).rotateX(Math.PI/2).translate(0,2.0,0),C.white],
  [prof([[-.26,1.96],[.12,1.96],[.12,1.86],[.3,2.02],[.12,2.18],[.12,2.08],[-.26,2.08]],.06,.03),GU_BLUE]]; }
// barrera de plástico (de las que se llenan de agua): voluminosa, se ve bien también desde arriba
function barrera(col){ return ()=>[[bx(-.62,.62,0,.62,.42),col],[bx(-.58,.58,.62,.8,.3),col],[bx(-.62,.62,.38,.5,.44),col===C.white?C.red:C.white]]; }
const PROP={valla,cono,arena,urbana,furgonUrbana,triangulo,pancarta,bandera,desvio,barreraR:barrera(C.red),barreraB:barrera(C.white)};
let IR=null;                                        // renderers de las piezas (se crean al primer uso)
function incRenderers(){ if(IR) return IR; IR={};
  for(const k in PROP) IR[k]=makeRenderer({name:k,w:0,len:2,parts:PROP[k],low:PROP[k]},120);
  IR.coche=makeRenderer(CAR_MODELS[1],20); IR.utilitario=makeRenderer(CAR_MODELS[0],20); IR.gente=makeRenderer(PED_MODELS[0],160); IR.gente2=makeRenderer(PED_MODELS[1],160);
  for(const k in IR) incGroup.add(...IR[k].hi,...IR[k].lo);                    // fuera del grupo de los coches (que se oculta a ratos)
  return IR; }
const incGroup=new THREE.Group(); root.add(incGroup);
// balizas: ámbar que parpadea (obras, intermitentes) y azul/rojo alternos (policía)
const beaconMat=new THREE.ShaderMaterial({ transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
  uniforms:{time:{value:0},mpp:U.mpp,dpr:{value:1}},
  vertexShader:`uniform float time,mpp,dpr; attribute vec3 aC; attribute float aF; attribute float aPh; varying vec3 vC; varying float vA;
    void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); float c=fract(time*aF+aPh);
      vA=aF>2.?step(0.5,c)*(0.6+0.4*step(0.75,c)):smoothstep(0.0,0.08,c)*smoothstep(0.55,0.45,c); vC=aC;
      gl_PointSize=clamp(2.2/mpp,5.,26.)*dpr; }`,
  fragmentShader:`varying vec3 vC; varying float vA; void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.) discard;
      gl_FragColor=vec4(vC*(exp(-d*d*3.)*0.9+smoothstep(.3,.05,d))*vA,1.); }`});
// aviso de lejos: icono a tinta sobre papel con un anillo que late (atlas de 6 iconos dibujados en un canvas)
function iconAtlas(){ const S=96, cv=document.createElement('canvas'); cv.width=S*6; cv.height=S; const g=cv.getContext('2d');
  const ink='#3a2616', red='#a9483a';
  for(let i=0;i<6;i++){ g.save(); g.translate(i*S+S/2,S/2);
    g.fillStyle='#f3ead6'; g.strokeStyle=ink; g.lineWidth=3; g.beginPath(); g.arc(0,0,30,0,7); g.fill(); g.stroke();
    g.strokeStyle=red; g.lineWidth=2; g.beginPath(); g.arc(0,0,35,0,7); g.stroke();
    g.strokeStyle=ink; g.fillStyle=ink; g.lineWidth=3; g.lineCap=g.lineJoin='round'; g.beginPath();
    if(i===0){ g.moveTo(-11,16); g.lineTo(0,-17); g.lineTo(11,16); g.closePath(); g.stroke(); g.fillStyle=red; g.fillRect(-7,-1,14,5); g.fillRect(-12,15,24,4); }   // obras: cono
    if(i===1){ g.font='bold 40px Georgia,serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillStyle=red; g.fillText('!',0,2); }                         // accidente
    if(i===2){ for(const x of [-12,0,12]){ g.beginPath(); g.arc(x,-6+(x?4:0),5,0,7); g.fill(); g.fillRect(x-4,2+(x?4:0),8,12); } g.fillStyle=red; g.fillRect(-16,-22,32,8); }  // manifestación
    if(i===3){ g.fillStyle=red; for(let k=0;k<4;k++) g.fillRect(-18+k*9,-6,5,12); g.strokeRect(-19,-7,38,14); g.moveTo(-15,7); g.lineTo(-15,17); g.moveTo(15,7); g.lineTo(15,17); g.stroke(); }  // cortada
    if(i===4){ g.moveTo(-14,14); g.lineTo(8,-8); g.stroke(); g.beginPath(); g.arc(11,-11,8,0.6,5.6); g.stroke(); }                                       // avería: llave
    if(i===5){ g.fillStyle=red; g.beginPath(); g.moveTo(0,-16); g.lineTo(-6,4); g.lineTo(6,4); g.closePath(); g.fill(); g.beginPath(); g.arc(0,12,3.5,0,7); g.fill(); }   // otra
    g.restore(); }
  const t=new THREE.CanvasTexture(cv); t.minFilter=THREE.LinearFilter; return t; }
const avisoMat=new THREE.ShaderMaterial({ transparent:true, depthTest:false, depthWrite:false,
  uniforms:{time:{value:0},atlas:{value:null},dpr:{value:1},op:{value:1},tgt:{value:new THREE.Vector2()},mpp:U.mpp},
  // siempre a la vista, a cualquier zoom; solo se apaga el de la incidencia que ya se ve de cerca (su escena está delante)
  vertexShader:`uniform float time,dpr,mpp; uniform vec2 tgt; attribute float aI; attribute float aPh; varying float vI; varying float vP; varying float vF;
    void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); vI=aI; vP=fract(time*0.6+aPh);
      float d=distance(position.xz,tgt); vF=1.-(1.-smoothstep(0.35,0.6,mpp))*(1.-smoothstep(120.,220.,d));
      gl_PointSize=vF>0.01?(mpp<1.?46.:58.)*dpr:0.; }`,
  fragmentShader:`uniform sampler2D atlas; uniform float op; varying float vI; varying float vP; varying float vF;
    void main(){ vec2 p=gl_PointCoord-.5; float r=length(p)*2.;
      float ring=smoothstep(0.035,0.,abs(r-(0.55+0.45*vP)))*(1.-vP)*0.8;              // anillo que se abre y se apaga
      vec2 uv=vec2((vI+0.5+p.x*1.35)/6.,0.5-p.y*1.35); vec4 ic=(abs(p.x)<0.37&&abs(p.y)<0.37)?texture2D(atlas,uv):vec4(0.);
      vec3 col=mix(vec3(0.66,0.28,0.23),ic.rgb,ic.a); float a=max(ic.a,ring)*vF; if(a<0.02) discard; gl_FragColor=vec4(col,a*op); }`});
const INC_TIPOS={obras:0,accidente:1,manifestacion:2,cortada:3,averia:4,otra:5};
let INCS=[], incReady=false, beacons=null, avisos=null; const INC_OBS=new Map(), INC_CERRADA=new Set();
const incLbl=[];
// ---- obstáculo para los coches: tramo [s0,s1] (medido desde el nodo a) de la calle e, en el sentido dir (−1 = ambos) y carriles
function incBloquea(e,dir,lanes,s0,s1){ let l=INC_OBS.get(e); if(!l) INC_OBS.set(e,l=[]); l.push({dir,lanes,s0,s1});
  // puntos del obstáculo (para los buses, que no van por el grafo): a lo largo del tramo, en cada carril afectado
  const E=RED.E[e], ln=lanesDir(E), pts=[], dirs=dir<0?[0,1]:[dir];
  for(const d of dirs) for(let k=0;k<ln;k++){ if(lanes&&!lanes.includes(k)) continue; const off=E.one?(k-(ln-1)/2)*3.1:1.65+k*3.1;
    for(let u=s0;u<=s1;u+=4){ edgePt(E,Math.max(0,Math.min(E.len,u)),d?-off:off,PQ); pts.push([PQ[0],PQ[1]]); } }
  return pts; }
function incGap(v,L,rem){ let g=1e9; const E=RED.E;
  const mira=(ei,dir,lane,base,sNow)=>{ const l=INC_OBS.get(ei); if(!l) return; const e=E[ei];
    for(const o of l){ if(o.dir>=0&&o.dir!==dir) continue; if(o.lanes&&!o.lanes.includes(lane)) continue;
      const st=dir?e.len-o.s1:o.s0, en=dir?e.len-o.s0:o.s1; if(sNow>en) continue; const d=base+st-sNow-L/2-2; if(d<g) g=Math.max(0,d); } };
  mira(v.e,v.dir,v.lane,0,v.s);
  if(v.next>=0){ const ne=E[v.next>>1]; mira(v.next>>1,v.next&1,Math.min(v.lane,lanesDir(ne)-1),rem,0); }
  return g; }
// ---- construir una incidencia de un tipo sobre la calle ei, en su punto medio, sentido a→b
// o.u: centro de la escena (metros desde el nodo a de la calle); o.dir: sentido de la marcha afectada (0 = a→b, 1 = b→a).
// Dentro, todo se mide en el sentido de la marcha: 'du' adelante/atrás desde el centro y 'lat' a la derecha del conductor.
const INC_EXT={obras:[-11,8],accidente:[-27,7],manifestacion:[-34,8],cortada:[-9,1],averia:[-31,3]};
function incPoner(tipo,ei,texto,o){
  o=o||{}; const E=RED.E, e=E[ei], ln=lanesDir(e), dir=e.one?0:(o.dir?1:0), sg=dir?-1:1;
  const ext=INC_EXT[tipo]||[-10,5];                                               // que la escena quepa en la calle
  const minM=dir?ext[1]:-ext[0], maxM=dir?e.len+ext[0]:e.len-ext[1];
  const mid=minM>maxM?e.len/2:Math.max(minM,Math.min(maxM,o.u??e.len/2));
  const inc={tipo,ei,texto,piezas:[],gente:[],luces:[],bloq:[],t0:performance.now()/1000};
  const U=du=>mid+sg*du;
  const bloquea=(lanes,d0,d1,ambos)=>{ const a=U(d0), b=U(d1); for(const p of incBloquea(ei,ambos?-1:dir,lanes,Math.min(a,b),Math.max(a,b))) inc.bloq.push(p); };
  const laneOff=l=>e.one?(l-(ln-1)/2)*3.1:1.65+l*3.1, outer=ln-1;
  const at=(du,lat)=>{ edgePt(e,Math.max(0.5,Math.min(e.len-0.5,U(du))),sg*lat,PQ); return [PQ[0],PQ[1],Math.atan2(-PQ[3],PQ[2])+(dir?Math.PI:0)]; };
  const pon=(k,du,lat,giro,col)=>{ const [x,z,a]=at(du,lat); inc.piezas.push([k,x,z,a+(giro||0),col]); };
  const luz=(du,lat,y,col,f,ph)=>{ const [x,z]=at(du,lat); inc.luces.push([x,y,z,col,f,ph]); };
  const persona=(du,lat,amp,f,ph,col)=>inc.gente.push({u:U(du),lat:sg*lat,amp,f,ph,col,flip:dir});
  const AMB=[1,0.62,0.2], AZ=[0.3,0.5,1], RO=[1,0.25,0.2];
  if(tipo==='obras'){ const lo=laneOff(0), L=14, d0=-L/2;                    // carril central: de arriba no lo tapan los árboles de la acera
    for(let k=0;k<7;k++){ pon('valla',d0+1+k*2,lo-1.45,0); pon('valla',d0+1+k*2,lo+1.45,0); }
    pon('valla',d0,lo,Math.PI/2); pon('valla',d0+L,lo,Math.PI/2);
    for(let k=0;k<4;k++) pon('cono',d0-3-k*3,lo-(k*0.35),0);
    pon('arena',2,lo+0.2,0.4);
    luz(d0,lo-1.45,1.15,AMB,1.2,0); luz(d0,lo+1.45,1.15,AMB,1.2,0.5); luz(d0+L,lo-1.45,1.15,AMB,1.2,0.25);
    persona(-3,lo-0.4,2.5,0.13,0,ORANGE); persona(4,lo+0.3,1.2,0.21,2,C.ochre);
    bloquea([0],d0-4,d0+L+0.5); }
  if(tipo==='accidente'){ const l0=laneOff(0), l1=laneOff(Math.min(1,outer));
    pon('coche',2.5,l1,0.35,C.blue); pon('utilitario',-2.3,(l0+l1)/2,-0.5,C.silver);
    pon('urbana',-11,l1,0);
    for(let k=0;k<5;k++) pon('cono',-16-k*2.5,l1-1.3+k*0.5*(ln>1?1:0.2),0);
    pon('triangulo',-26,l1,Math.PI/2);
    for(const [d,l] of [[4.6,l1],[0.4,l1],[-0.2,(l0+l1)/2],[-4.4,(l0+l1)/2]]){ luz(d,l-0.75,0.65,AMB,1.6,0); luz(d,l+0.75,0.65,AMB,1.6,0); }
    luz(-11,l1-0.35,1.62,AZ,3.2,0); luz(-11,l1+0.35,1.62,RO,3.2,0.5);
    persona(-8,l1+2.2,0.6,0.1,1,GU_BLUE); persona(6,l1+2.4,0.3,0.05,0,C.red);
    bloquea(ln>1?[0,1]:[0],-18,5.5); }
  if(tipo==='manifestacion'){ const W=e.one?ln*3.1:ln*3.1*2, L=26;
    inc.marcha={u0:U(-L/2-20),sg,len:40,v:0.55};
    for(let k=0;k<70;k++) inc.gente.push({mar:true,du:Math.random()*L,lat:(Math.random()-0.5)*(W-2),col:ROPA[k%ROPA.length],ph:Math.random()*6});
    inc.pancartas=[{du:L+0.8,lat:-2.2},{du:L+0.8,lat:2.2},{du:L*0.45,lat:0}];
    inc.banderas=[{du:L*0.7,lat:-3,col:C.red},{du:L*0.25,lat:2.6,col:C.green},{du:L*0.55,lat:3.4,col:0x8a7aa8}];
    INC_CERRADA.add(ei); for(const p of incBloquea(ei,-1,null,0,e.len)) inc.bloq.push(p); }
  if(tipo==='cortada'){ const W=e.one?ln*3.1:ln*3.1*2, c0=e.one?0:0;
    let k=0; for(let x=-W/2+0.7;x<=W/2-0.6;x+=1.3) pon(k++%2?'barreraB':'barreraR',0,c0+x,Math.PI/2);    // barreras de lado a lado
    for(let x=-W/2+1.2;x<W/2-0.8;x+=2.2) pon('cono',-3,c0+x,0);
    pon('desvio',-5,W/2+0.6,Math.PI/2); pon('urbana',-9,laneOff(0),0);
    luz(0,-W/2+0.95,1.15,AMB,1.2,0); luz(0,W/2-0.95,1.15,AMB,1.2,0.5);
    luz(-9,laneOff(0)-0.35,1.62,AZ,3.2,0); luz(-9,laneOff(0)+0.35,1.62,RO,3.2,0.5);
    persona(-6,laneOff(0)+1.6,1.5,0.07,0,GU_BLUE);
    INC_CERRADA.add(ei); bloquea(null,-1,1,true); }
  if(tipo==='averia'){ const lo=laneOff(outer);
    pon('utilitario',0,lo+0.3,0,C.red);
    pon('triangulo',-30,lo,Math.PI/2);
    luz(2,lo-0.55,0.65,AMB,1.4,0); luz(2,lo+1.15,0.65,AMB,1.4,0); luz(-1.95,lo-0.55,0.75,AMB,1.4,0); luz(-1.95,lo+1.15,0.75,AMB,1.4,0);
    persona(-3.5,lo+2.6,0.8,0.08,0,C.ochre);
    bloquea([outer],-6,2.6); }
  const [cx,cz]=at(0,0); inc.x=cx; inc.z=cz; inc.i=INC_TIPOS[tipo]??5;
  INCS.push(inc); return inc;
}
function incBuildGPU(){
  const P=[],Cc=[],F=[],Ph=[]; for(const inc of INCS) for(const [x,y,z,c,f,ph] of inc.luces){ P.push(x,y,z); Cc.push(...c); F.push(f); Ph.push(ph); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(P,3)); g.setAttribute('aC',new THREE.Float32BufferAttribute(Cc,3));
  g.setAttribute('aF',new THREE.Float32BufferAttribute(F,1)); g.setAttribute('aPh',new THREE.Float32BufferAttribute(Ph,1));
  if(beacons){ root.remove(beacons); beacons.geometry.dispose(); }
  beacons=new THREE.Points(g,beaconMat); beacons.frustumCulled=false; beacons.renderOrder=996; root.add(beacons);
  const A=[],I=[],H=[]; for(const inc of INCS){ A.push(inc.x,14,inc.z); I.push(inc.i); H.push(Math.random()); }
  const g2=new THREE.BufferGeometry(); g2.setAttribute('position',new THREE.Float32BufferAttribute(A,3)); g2.setAttribute('aI',new THREE.Float32BufferAttribute(I,1)); g2.setAttribute('aPh',new THREE.Float32BufferAttribute(H,1));
  if(!avisoMat.uniforms.atlas.value) avisoMat.uniforms.atlas.value=iconAtlas();
  if(avisos){ root.remove(avisos); avisos.geometry.dispose(); }
  avisos=new THREE.Points(g2,avisoMat); avisos.frustumCulled=false; avisos.renderOrder=999; root.add(avisos);
}
function incDemo(){
  // cinco calles principales distintas cerca de Passeig de Gràcia × Gran Via (donde aterriza la entrada)
  const c=K.intro||{x:1468,z:1135}, E=RED.E, cand=[];
  E.forEach((e,i)=>{ const d=Math.hypot(e.mx-c.x,e.mz-c.z); if(e.cls>=1&&e.cls<=4&&e.len>70&&d>25&&d<260&&!tramCerca(e.mx,e.mz,6)) cand.push([d,i]); });
  cand.sort((a,b)=>a[0]-b[0]); const elegidas=[];
  for(const [,i] of cand){ if(elegidas.length>=5) break; if(elegidas.every(j=>Math.hypot(E[j].mx-E[i].mx,E[j].mz-E[i].mz)>70)) elegidas.push(i); }
  const tipos=[['obras','Obras · carril cortado (demostración)'],['accidente','Accidente · restricciones (demostración)'],['manifestacion','Manifestación · calle cortada (demostración)'],
    ['cortada','Calle cortada (demostración)'],['averia','Vehículo averiado (demostración)']];
  elegidas.forEach((ei,k)=>incPoner(tipos[k][0],ei,tipos[k][1]));
  incBuildGPU();
}
/* --- Incidencias reales: los avisos del Ayuntamiento (/api/incidencias, cada 5 min) situados con el callejero de OSM.
       El aviso da el sitio en texto: «C. Muntaner a l´altura de C. la Forja tallat al trànsit per obres.» → la calle
       (Muntaner), el cruce (la Forja), el sentido si lo dice (muntanya, mar, Besòs, Llobregat), la causa y el efecto. --- */
let CALL=null, callState='none', incLast=-1e9, incFrases=null, INC_N=0, INC_SIN=[];
const VACIAS=new Set(['carrer','c','cl','avinguda','av','avda','passeig','pg','pl','placa','rda','travessera','trav','rambla','rbla','via','carretera','ctra',
  'passatge','ptge','baixada','pujada','de','del','dels','la','les','el','els','l','d','i','al','a']);
const tokens=s=>(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[´'’`·]/g,' ').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w&&!VACIAS.has(w));
async function loadCallejero(){ callState='loading';
  try{ const d=await fetch(VIVO+'callejero.json',{cache:'no-cache'}).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); });
    CALL=d.calles.map(([nom,ed])=>({nom,tok:new Set(tokens(nom)),tv:tipoVia(nom),ed})); callState='ready'; okLoad('callejero'); }
  catch(e){ callState='missing'; retryLater('callejero',()=>{ if(callState==='missing') callState='none'; },e); } }
// calles cuyo nombre contiene todas las palabras del aviso (primero las que coinciden exactamente)
// tipo de vía (carrer, plaça, avinguda…) a partir de la primera palabra, abreviada o no
const TIPO_VIA={c:'carrer',cl:'carrer',carrer:'carrer',av:'avinguda',avda:'avinguda',avinguda:'avinguda',pg:'passeig',passeig:'passeig',pl:'placa',placa:'placa',
  rda:'ronda',ronda:'ronda',trav:'travessera',travessera:'travessera',rbla:'rambla',rambla:'rambla',gran:'gran',ptge:'passatge',passatge:'passatge'};
const tipoVia=s=>TIPO_VIA[((s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').match(/[a-z]+/)||[''])[0]]||'';
function calles(nombre){ const t=tokens(nombre); if(!t.length) return []; const tv=tipoVia(nombre);
  const r=CALL.filter(c=>t.every(w=>c.tok.has(w)));
  const nota=c=>(c.tok.size-t.length)*10+(tv&&c.tv!==tv?5:0)-Math.min(4,c.ed.length/15);   // nombre exacto, mismo tipo, calle larga
  r.sort((a,b)=>nota(a)-nota(b)); return r.slice(0,6); }
const nodosDe=c=>{ const s=new Set(); for(const i of c.ed){ s.add(RED.E[i].a); s.add(RED.E[i].b); } return s; };
// cruce de dos calles: nodo común, o el par de nodos más cercano a menos de 60 m (plazas, calzadas desdobladas)
function cruce(A,B){
  for(const a of A) for(const b of B){ const nb=nodosDe(b); for(const n of nodosDe(a)) if(nb.has(n)) return {calle:a,nodo:n}; }
  let best=null;
  for(const a of A) for(const b of B){ const nb=[...nodosDe(b)];
    for(const n of nodosDe(a)) for(const m of nb){ const d=Math.hypot(RED.nx[n]-RED.nx[m],RED.nz[n]-RED.nz[m]); if(d<90&&(!best||d<best.d)) best={calle:a,nodo:n,d}; } }
  return best; }
const SENTIT={muntanya:[-0.71,-0.71],mar:[0.71,0.71],besos:[0.71,-0.71],llobregat:[-0.71,0.71]};
// tramo de la calle que llega al nodo (en el sentido del aviso si lo dice): la escena queda justo antes del cruce
function junto(calle,nodo,sent){ const E=RED.E; let best=null;
  for(const i of calle.ed){ const e=E[i]; if(e.a!==nodo&&e.b!==nodo) continue;
    for(const dir of e.one?[0]:[0,1]){ const hacia=dir?e.a:e.b, desde=dir?e.b:e.a;                 // nodo al que va la marcha
      const vx=RED.nx[hacia]-RED.nx[desde], vz=RED.nz[hacia]-RED.nz[desde], L=Math.hypot(vx,vz)||1;
      let p=(hacia===nodo?2:0)+Math.min(1,e.len/60);                                                  // mejor si llega al cruce
      if(sent) p+=3*(vx*sent[0]+vz*sent[1])/L;
      if(!best||p>best.p) best={ei:i,dir,p,u:hacia===nodo?(dir?14:e.len-14):(dir?e.len-14:14)}; } }
  return best; }
function causaDe(t){ t=t.toLowerCase();
  return /accident|xoc|col·lisi|atropell/.test(t)?'accidente':/avaria|avariat/.test(t)?'averia':/obres|obra\b|asfaltat|pavimentaci/.test(t)?'obras'
    :/manifestaci|concentraci|protesta|vaga/.test(t)?'manifestacion':/esdeveniment|cursa|marat|festa|concert|partit|cavalcada|desfilada|fira|rodatge|filmaci/.test(t)?'evento'
    :/incendi|emergència|inundaci|despreniment|fuita|bombers/.test(t)?'emergencia':'sin_indicar'; }
function situar(frase){
  const tramo=frase.match(/^(.+?)\s+de\s+((?:(?!\s+de\s).)+?)\s+fins\s+a\s+(.+?)(?:,|\s+tallat|\s+tallada|\s+restricc|\.?\s*$)/i);
  const via=tramo?tramo[1]:frase.split(/\s+sentit\s+|\s+a\s+l[´'’]altura|,|\s+tallat|\s+tallada|\s+restricc/i)[0];
  const alt=frase.match(/a\s+l[´'’]altura\s+(?:de\s+la\s+|del\s+|de\s+|d[´'’])?(.+?)(?:,|\s+tallat|\s+tallada|\s+restricc|\s+per\s+|\.?\s*$)/i);
  const sm=frase.match(/sentit\s+(muntanya|mar|bes[oò]s|llobregat)/i), sent=sm?SENTIT[tokens(sm[1])[0]]:null;
  const A=calles(via); if(!A.length) return null;
  if(tramo){ const c1=cruce(A,calles(tramo[2])), c2=cruce(A,calles(tramo[3]));
    if(c1&&c2){ const mx=(RED.nx[c1.nodo]+RED.nx[c2.nodo])/2, mz=(RED.nz[c1.nodo]+RED.nz[c2.nodo])/2; let best=null;
      for(const i of c1.calle.ed){ const e=RED.E[i], d=Math.hypot(e.mx-mx,e.mz-mz); if(!best||d<best.d) best={ei:i,d}; }
      return best&&{ei:best.ei,dir:0,u:RED.E[best.ei].len/2}; }
    const c=c1||c2; if(c) return junto(c.calle,c.nodo,sent); }
  if(alt){ const B=calles(alt[1]), c=B.length?cruce(A,B):null; if(c) return junto(c.calle,c.nodo,sent); }
  // solo la calle (una plaza, un tramo corto): su tramo más largo, si la calle no es muy grande
  const a=A[0]; let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9,best=null;
  for(const i of a.ed){ const e=RED.E[i]; x0=Math.min(x0,e.mx); x1=Math.max(x1,e.mx); z0=Math.min(z0,e.mz); z1=Math.max(z1,e.mz); if(best==null||e.len>RED.E[best].len) best=i; }
  if(Math.hypot(x1-x0,z1-z0)>500||best==null) return null;                  // calle larga sin cruce: no se sabe dónde
  return {ei:best,dir:0,u:RED.E[best].len/2}; }
function incReales(frases){
  INCS=[]; INC_OBS.clear(); INC_CERRADA.clear(); INC_SIN=[]; INC_N=frases.length;
  for(const f of frases){ const s=situar(f); if(!s){ INC_SIN.push(f); continue; }
    const causa=causaDe(f), cortado=/tallat|tallada|tall\b|tancat|tancada/i.test(f);
    const tipo=causa==='accidente'?'accidente':causa==='averia'?'averia':causa==='manifestacion'?'manifestacion':cortado?'cortada':causa==='obras'?'obras':'cortada';
    const inc=incPoner(tipo,s.ei,f.replace(/\.$/,''),s); if(causa==='obras') inc.i=0;            // corte por obras: icono de obras
  }
  incBuildGPU(); K.dirty(); panel();
}
// estado visible en el panel «En vivo» (para saber qué pasa en un equipo donde no salen)
let incEstado='pendiente';
async function loadIncidencias(){
  try{ incEstado=incEstado==='pendiente'?'pidiendo avisos':incEstado;
    const r=await fetch('/api/incidencias',{cache:'no-store'}); if(!r.ok){ incEstado='el servidor respondió '+r.status; incLast=performance.now()-20000; panel(); return; }
    const d=await r.json(), fr=d.frases||[];
    if(JSON.stringify(fr)===JSON.stringify(incFrases)){ return; }
    if(callState==='none'||callState==='missing'){ incEstado='cargando el callejero'; await loadCallejero(); }
    if(!CALL){ incEstado='no se pudo cargar el callejero ('+(LOADERR.callejero||'?')+')'; incLast=performance.now()-20000; panel(); return; }   // se reintenta en 10 s
    incReales(fr); incFrases=fr; incEstado='ok'; panel(); }
  catch(e){ incEstado='error: '+String(e&&e.message||e).slice(0,80); incLast=performance.now()-20000; console.warn('vivo: incidencias',e); panel(); } }   // fallo: otra vez en 10 s
const _ic=new THREE.Color();
// ¿cae (calle, sentido, carril, posición) dentro de una incidencia? (para no hacer aparecer coches ahí)
function incDentro(ei,dir,lane,s){ const l=INC_OBS.get(ei); if(!l) return false; const e=RED.E[ei], u=dir?e.len-s:s;
  for(const o of l){ if((o.dir<0||o.dir===dir)&&(!o.lanes||o.lanes.includes(lane))&&u>o.s0-8&&u<o.s1+8) return true; } return false; }
// buses (van por su recorrido, no por el grafo): ¿incidencia en su carril justo delante? → distancia hasta ella o −1
function incBus(x,z,da,front){ const dx=Math.cos(da), dz=Math.sin(da); let g=-1;
  for(const inc of INCS) for(const [px,pz] of inc.bloq){ const rx=px-x, rz=pz-z, lon=rx*dx+rz*dz; if(lon<=0||lon>front+25) continue;
    if(Math.abs(-rx*dz+rz*dx)<2.2){ const d=Math.max(0,lon-front-2); if(g<0||d<g) g=d; } }
  return g; }
function incStep(now,dt,mpp){
  if(!INCS.length) return false;
  const t=now/1000, R=incRenderers(); for(const k in R) R[k].n=0;
  const put=(k,x,z,a,s,col,y)=>{ const r=R[k]; if(r.n>=r.cap) return; writePose(r.mat.array,r.n,x,z,a,s,y); _ic.set(col==null?0xffffff:col); const A=r.color.array; A[r.n*3]=_ic.r; A[r.n*3+1]=_ic.g; A[r.n*3+2]=_ic.b; r.n++; };
  const cerca=mpp<VEH_MPP, cam=K.controls.target, R2=(area.r||600)**2*1.6;
  for(const inc of INCS){ if((inc.x-cam.x)**2+(inc.z-cam.z)**2>R2||!cerca) continue;
    const e=RED.E[inc.ei];
    for(const [k,x,z,a,col] of inc.piezas) put(k,x,z,a,1,col);
    if(inc.marcha){ const M=inc.marcha, adv=((t-inc.t0)*M.v)%M.len, g=M.sg, rot=g<0?Math.PI:0;   // la marcha avanza despacio y vuelve a empezar
      const f=Math.min(1,adv/3,(M.len-adv)/3), en=(d,lat)=>{ edgePt(e,Math.max(0.3,Math.min(e.len-0.3,M.u0+g*(adv+d))),g*lat,PQ); return Math.atan2(-PQ[3],PQ[2])+rot; };
      for(const p of inc.gente){ const a=en(p.du,p.lat), bob=Math.abs(Math.sin(t*3.2+p.ph))*0.05; put(p.ph>3?'gente':'gente2',PQ[0],PQ[1],a,f,p.col,0.3+bob); }
      for(const b of inc.pancartas){ const a=en(b.du,b.lat); put('pancarta',PQ[0],PQ[1],a+Math.PI/2+Math.sin(t*1.3+b.lat)*0.08,f,null); }
      for(const b of inc.banderas){ const a=en(b.du,b.lat); put('bandera',PQ[0],PQ[1],a+Math.PI+Math.sin(t*2.1+b.lat)*0.35,f,b.col); }
      const a=en(-7,1.6); put('furgonUrbana',PQ[0],PQ[1],a,f,null); }
    else for(const p of inc.gente){ const u=p.u+Math.sin(t*p.f*6.283+p.ph)*p.amp; edgePt(e,u,p.lat,PQ);
      const dir=Math.cos(t*p.f*6.283+p.ph)>=0?0:Math.PI; put('gente',PQ[0],PQ[1],Math.atan2(-PQ[3],PQ[2])+dir,1,p.col,0.3+Math.abs(Math.sin(t*3+p.ph))*0.03); } }
  for(const k in R) setCount(R[k],R[k].n);
  { const hi=mpp<HI_MPP; for(const k in R){ for(const im of R[k].hi) im.visible=hi; for(const im of R[k].lo) im.visible=!hi; } }
  const dpr=K.renderer.getPixelRatio(); beaconMat.uniforms.time.value=t; beaconMat.uniforms.dpr.value=dpr; beacons.visible=cerca;
  avisoMat.uniforms.time.value=t; avisoMat.uniforms.dpr.value=dpr; avisoMat.uniforms.tgt.value.set(cam.x,cam.z); avisos.visible=true;
  // rótulos (solo en la demostración): qué es cada una
  let used=0;
  if(INC_DEMO?mpp<1.5:mpp<0.6) for(const inc of INCS){ _p.set(inc.x,0,inc.z).project(K.cam); if(Math.abs(_p.x)>1||Math.abs(_p.y)>1) continue;
    const yS=(1-_p.y)/2*innerHeight; _p.set(inc.x,4,inc.z).project(K.cam); const alto=Math.max(0,yS-(1-_p.y)/2*innerHeight);   // 4 m en píxeles
    let el=incLbl[used]; if(!el){ el=document.createElement('span'); el.style.cssText='position:absolute;transform:translate(-50%,-100%);font:600 11px/1.2 "EB Garamond",serif;color:#3a2616;background:rgba(243,234,214,.92);padding:1px 5px;border:1px solid #a9483a;border-radius:2px;white-space:nowrap;max-width:46vw;overflow:hidden;text-overflow:ellipsis'; busLblBox.appendChild(el); incLbl.push(el); }
    el.style.marginTop=(-alto*2.5-14)+'px';                                       // por encima de la escena, sin taparla
    el.textContent=inc.texto; el.style.left=((_p.x+1)/2*innerWidth)+'px'; el.style.top=((1-_p.y)/2*innerHeight)+'px'; el.style.display='block'; used++; }
  for(let i=used;i<incLbl.length;i++) incLbl[i].style.display='none';
  return true;
}

/* ================= Bucle ================= */
let lastPanel=0, simErr='', lastStep=0;
// Errores: se muestran en el panel y se envían una vez por capa y visita al Worker (/api/error, sin datos personales:
// mensaje, navegador y zoom), para poder arreglar fallos que solo pasan en algún equipo
const enviados=new Set();
function fallo(donde,e){
  const msg=String(e&&e.stack||e).slice(0,600);
  if(!simErr){ simErr=donde+': '+msg.slice(0,280); console.error('vivo:',donde,e); panel(); }
  if(enviados.has(donde)) return; enviados.add(donde);
  try{ const cuerpo=JSON.stringify({donde,msg,ua:navigator.userAgent,mpp:K.mppNow&&+K.mppNow().toFixed(3),embed:!!window.EMBED,
      gl:(()=>{ try{ const g=K.renderer.getContext(), x=g.getExtension('WEBGL_debug_renderer_info'); return x?g.getParameter(x.UNMASKED_RENDERER_WEBGL):''; }catch(_){ return ''; } })(),ts:new Date().toISOString()});
    if(navigator.sendBeacon) navigator.sendBeacon('/api/error',new Blob([cuerpo],{type:'application/json'})); else fetch('/api/error',{method:'POST',body:cuerpo,keepalive:true}); }catch(_){} }
function capa(donde,f){ try{ f(); }catch(e){ fallo(donde,e); } }
K.frameHooks.push((now,dt)=>{ try{ return frame(now,dt); }catch(e){ fallo('fotograma',e); vehGroup.visible=true; return false; } });
function frame(now,dt){
  const city=K.mode==='city'; root.visible=city;
  if(K.mode==='under'){ if(metState==='none') loadMetro(); if(MET){ metroStep(now); if(now-lastPanel>2000){ lastPanel=now; panel(); } return true; } return false; }
  if(!city) return false;
  const mpp=K.mppNow();
  VSC=Math.min(1.8,Math.max(1,mpp/1.1));
  const wxAnim=wxStep(now,dt,mpp);
  // incidencias: lo primero y por separado (tienen su propio grupo): un fallo en otra capa no las deja ocultas
  let incA=false;
  try{ if(INC_DEMO&&!incReady&&RED&&tramState!=='loading'&&tramState!=='none'){ incReady=true; incDemo(); }
    if(!INC_DEMO&&RED&&now-incLast>30000){ incLast=now; loadIncidencias(); }      // avisos reales del Ayuntamiento, cada 30 s (si falla, a los 10 s)
    incGroup.visible=INCS.length>0; incA=INCS.length?incStep(now,dt,mpp):false; }
  catch(e){ fallo('incidencias',e); }
  ribbonGroup.visible=ON.trafico&&!!ribbon; ribbonMat.uniforms.w.value=mpp*2.2; ribbonMat.uniforms.op.value=mpp<0.8?0.35:0.9;
  bikeGroup.visible=ON.bicing&&!!bars;
  let anim=false;
  if(ON.vehiculos&&mpp<VEH_MPP*1.6&&redState==='none') loadRed();
  vehGroup.visible=false;
  if(ON.vehiculos&&mpp<VEH_MPP*1.6&&busState==='none') loadBuses();
  if(ON.vehiculos&&mpp<VEH_MPP*1.6&&tramState==='none') loadTram();
  nTramWait=0;
  // cada capa por separado: si una falla en algún navegador, las demás siguen (y el error se apunta y se envía)
  capa('vehículos',()=>{
    if(ON.vehiculos&&mpp<VEH_MPP&&RED){ ensureRenderers();
      if(TRAM){ if(!RT) RT=makeRenderer(TRAM_MODEL,90); tramStep(now,dt,true); }      // primero el tranvía: reserva sus cruces
      sync(now); step(dt); if(BUS) busStep(now,dt); anim=true; lastStep=now; }
    else if(RT) setCount(RT,0); });
  if(tramRails) tramRails.visible=ON.vehiculos&&mpp<VEH_MPP*1.6;
  if(ON.bicing&&mpp<CYC_MPP*1.6&&bkState==='none') loadBici();
  let cyc=false;
  capa('ciclistas',()=>{
    if(ON.bicing&&mpp<CYC_MPP&&BK&&BIKE){ if(!RBC) RBC=BIKE_MODELS.map(m=>makeRenderer(m,CYC_CAP)); cycStep(now,dt); cyc=true; }
    else if(RBC) for(const r of RBC) setCount(r,0); });
  if(ON.personas&&mpp<PED_MPP*1.6){ if(redState==='none') loadRed(); if(calzState==='none') loadCalzada(); }
  let ped=false;
  capa('personas',()=>{
    if(ON.personas&&mpp<PED_MPP&&RED&&CALZ){ if(!PN) prepPed(); if(!PEDR) PEDR=PED_MODELS.map(m=>makeRenderer(m,PED_CAP)); pedFrame(now,dt); ped=true; }
    else if(PEDR){ for(const r of PEDR) setCount(r,0); nPed=nPedWait=0; } });
  { const hi=mpp<HI_MPP; for(const r of [...(RC||[]),...(RB||[]),...(RP||[]),...(RBC||[]),...(RT?[RT]:[])]){ for(const im of r.hi) im.visible=hi; for(const im of r.lo) im.visible=!hi; } }
  if(RP&&mpp>=PARK_MPP) for(const r of RP){ for(const im of r.hi) im.visible=false; for(const im of r.lo) im.visible=false; }
  if(PEDR){ const hi=mpp<PED_HI; for(const r of PEDR){ for(const im of r.hi) im.visible=hi; for(const im of r.lo) im.visible=!hi; } }
  anim=anim||cyc||ped||incA;
  vehGroup.visible=anim; if(!anim||!BUS) hideBusLabels();
  if(now-lastPanel>2000){ lastPanel=now; if(anim||redState==='loading') panel(); }
  return anim||wxAnim;
}
window.__vivo={
  // para el test exhaustivo: forzar un clima y saltarse la transición suave
  wxModes:Object.keys(WX_SIMS), get wxSim(){ return wxSim; }, setWx:k=>setWxSim(k),
  setOn:(k,v)=>{ ON[k]=!!v; K.dirty(); panel(); }, get ON(){ return {...ON}; }, get peds(){ return peds; }, isRoad:(x,z)=>CALZ?isRoad(x,z):null, pedXY:p=>{ const o=new Float32Array(4); pedPos(p,o); return [o[0],o[1]]; },   // el test apaga y enciende capas sin tocar lo guardado
  wxSnap:()=>{ wxT=wxTarget(); for(const k in WXV) WXV[k]=wxT[k]; K.dirty(); },
  wx:()=>({...WXV,sim:wxSim,t:wxT,m1:wxM1.visible,m2:wxM2.visible,u:Object.fromEntries(Object.entries(wxMul.uniforms).map(([k,v])=>[k,typeof v.value==='number'?v.value:'·']))}),stats:()=>({lamps:lamps&&lamps.visible?nLamps:0,lmLights:lamps&&lamps.visible?nLmLights:0,ribbons:!!(ribbon&&ribbonGroup.visible),tramos:TRAF?TRAF.size:0,tramosState,bikeStations:BIKE&&BIKE.estaciones?BIKE.estaciones.length:0,bars:!!(bars&&bikeGroup.visible),wxM1:wxM1.visible,wxM2:wxM2.visible,manifest:!manifestErr,capas:manifest&&manifest.capas?Object.fromEntries(Object.entries(manifest.capas).map(([k,c])=>[k,c.estado||''])):{},cars:nCars,stopped:nStopped,parked:nParked,buses:nBuses,busAll:nBusAll,incs:INCS.map(i=>[i.tipo,Math.round(i.x),Math.round(i.z),i.texto]),incSin:INC_SIN,tram:nTram,tramAll:nTramAll,tramWait:nTramWait,tramState,busLight:nBusLight,busJunc:nBusJunc,cyc:nCyc,cycLight:nCycLight,peds:nPed,pedWait:nPedWait,pedTarget,calzada:calzState,metro:nMetroAll,red:redState,bus:busState,bici:bkState,err:simErr,loadErr:{...LOADERR}}),get RED(){return RED;},get cand(){return cand;},get area(){return area;},get candTot(){return candTot;},get RC(){return RC;},get RB(){return RB;},get TRAF(){return TRAF;},get busActive(){return busActive;},get cycs(){return cycs;},get cyc(){ return {bkState,queue:cycQueue.length,cycs:cycs.length,area:cycArea,bike:!!BIKE,seen:cycSeen,ev:BIKE&&BIKE.eventos&&BIKE.eventos.length,rbc:!!RBC,cerca:cycs.filter(c=>c.x!==undefined).map(c=>[c.x,c.z,Math.hypot(c.x-cycArea.x,c.z-cycArea.z)]).sort((a,b)=>a[2]-b[2]).slice(0,3)}; },busXY(tr){ const o=new Float32Array(4); busPos(tr,secNow(),o); return [o[0],o[1]]; }};   // inspección
// Todo lo que hace falta para acercarse sin sorpresas se carga ya, y index.html mantiene la pantalla de carga hasta que
// termine (antes, si se hacía zoom en los primeros segundos, coches y personas arrancaban con datos a medio cargar)
K.listo=Promise.all([poll(),
  redState==='none'?loadRed():null, busState==='none'?loadBuses():null, bkState==='none'?loadBici():null, tramState==='none'?loadTram():null,
  ON.personas&&calzState==='none'?loadCalzada():null]).catch(e=>console.warn('vivo: carga inicial',e));
setInterval(poll,POLL_MS); setInterval(panel,15000);
})();
