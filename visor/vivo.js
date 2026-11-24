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
  {name:'de barrio',w:10,lowCol:C.white,len:8.2,parts:barrio,maxCls:7},{name:'eléctrico',w:15,lowCol:C.teal,len:12.2,parts:electrico,maxCls:6},{name:'turístico',w:5,lowCol:C.wine,len:11.2,parts:turistico,maxCls:3}];

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
  const ok=opts.filter(p=>p!==rev&&(!v.bus||E[p>>1].cls<=5));
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
    const lane=Math.floor(Math.random()*lanesDir(e)), l=lanesMap.get((ei*2+dir)*8+lane);
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
  const dd=dist[k]+(dist[k+1]-dist[k])*f, c=sh.c, cu=sh.cum, n=cu.length;
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
  _sd.sort((a,b)=>a-b); v=_sd.length>=2?_sd[_sd.length>>1]:NO_ACERA; PN.off[k]=v; return v; }
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
function pedMove(p,dt){
  p.age+=dt; p.waiting=false;
  if(p.fade>=0){ p.fade-=dt; if(p.fade<=0) p.dead=true; return; }
  if(p.tr){ p.tr.s+=p.v*dt; if(p.tr.s>=p.tr.L){ const n=p.tr; p.e=n.e; p.dir=n.dir; p.lat=n.lat; p.tr=null; p.nx=null; pedRange(p); p.s=0; } return; }
  if(!p.nx&&p.s>p.W-6) planNext(p);
  let ds=p.v*dt;
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
      { vec2 w=ground(); for(int i=0;i<32;i++){ vec4 l=lmL[i]; if(l.z<=0.) break; fl=max(fl,smoothstep(l.z,l.z*0.45,distance(w,l.xy))); } fl*=lit; }
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
      gl_PointSize=vA>0.001?clamp(px,2.2,aR>12.?150.:30.)*dpr:0.; }        // farolas: como mucho 44 px; focos de monumentos, más`,
  fragmentShader:`uniform float fog,night; varying float vA; varying float vK; varying vec3 vC;
    void main(){ float d=length(gl_PointCoord-0.5)*2.; if(d>1.) discard;
      float glow=exp(-d*d*(3.2-fog*1.4))*(0.62+0.25*fog), core=smoothstep(0.13,0.02,d)*vK;
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
function setDefs(mat,want){ const d={}; let key=''; for(const k in want) if(want[k]){ d[k]=''; key+=k+','; }
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
  if(!wxStep.lm&&K.LMS){ wxStep.lm=1; K.LMS.slice(0,32).forEach((l,i)=>{ const a=l.axis||{}; u.lmL.value[i].set(l.x,l.z,Math.max(25,(Math.max(a.len||0,a.wid||0))*0.6+(l.spire_h||l.body_h||20)*0.9),1); }); }
  u.lit.value=WXV.lights;
  // versión del shader con solo lo necesario (cada combinación se compila una vez y se reutiliza)
  setDefs(wxMul,{W_NUBES:WXV.cloud>0.01&&WXV.cloud<=0.96, W_FOCOS:WXV.lights>0.01&&WXV.dark>0.01});
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
  let wx='';
  if(WX){ const desc=window.LANG==='en'?wmoTxt(WX.codigo):(WX.descripcion||wmoTxt(WX.codigo));
    wx=`<div class="wx">${Math.round(WX.temperatura)} °C · ${desc} · ${TX('viento','wind')} ${Math.round(WX.viento_kmh)} km/h${WX.lluvia_mm?` · ${TX('lluvia','rain')} ${WX.lluvia_mm} mm`:''}</div>`; }
  const note=manifestErr?`<div class="note">${window.LOCAL?TX('Sin datos en vivo todavía. En otra ventana: <b>python pipeline\\vivo.py</b>','No live data yet. In another window: <b>python pipeline\\vivo.py</b>'):TX('Sin datos en vivo ahora mismo; se reintenta solo.','No live data right now; retrying automatically.')}</div>`:'';
  const cerrar=hoja()?'×':(box.classList.contains('min')?'+':'–');
  box.innerHTML=`<h3>${TX('En vivo','Live')} <button id="vivoMin" aria-label="${hoja()?TX('Cerrar','Close'):TX('Plegar','Collapse')}">${cerrar}</button></h3><div class="body">
    ${row('trafico',tr,true)}${row('vehiculos',vh,true)}${row('bicing',bk,true)}${row('tiempo',wxLine(),true)}
    ${row('bus',bs,false)}${row('metro',mt,false)}${row('personas',pr,true)}${wx}${note}</div>`;
}

/* ================= Bucle ================= */
let lastPanel=0, simErr='', lastStep=0;
K.frameHooks.push((now,dt)=>{ try{ return frame(now,dt); }catch(e){ if(!simErr){ simErr=String(e&&e.stack||e).slice(0,300); console.error('vivo:',e); panel(); } return false; } });
function frame(now,dt){
  const city=K.mode==='city'; root.visible=city;
  if(K.mode==='under'){ if(metState==='none') loadMetro(); if(MET){ metroStep(now); if(now-lastPanel>2000){ lastPanel=now; panel(); } return true; } return false; }
  if(!city) return false;
  const mpp=K.mppNow();
  VSC=Math.min(1.8,Math.max(1,mpp/1.1));
  const wxAnim=wxStep(now,dt,mpp);
  ribbonGroup.visible=ON.trafico&&!!ribbon; ribbonMat.uniforms.w.value=mpp*2.2; ribbonMat.uniforms.op.value=mpp<0.8?0.35:0.9;
  bikeGroup.visible=ON.bicing&&!!bars;
  let anim=false;
  if(ON.vehiculos&&mpp<VEH_MPP*1.6&&redState==='none') loadRed();
  vehGroup.visible=false;
  if(ON.vehiculos&&mpp<VEH_MPP*1.6&&busState==='none') loadBuses();
  if(ON.vehiculos&&mpp<VEH_MPP&&RED){ ensureRenderers(); sync(now); step(dt); if(BUS) busStep(now,dt); anim=true; lastStep=now; }
  if(ON.bicing&&mpp<CYC_MPP*1.6&&bkState==='none') loadBici();
  let cyc=false;
  if(ON.bicing&&mpp<CYC_MPP&&BK&&BIKE){ if(!RBC) RBC=BIKE_MODELS.map(m=>makeRenderer(m,CYC_CAP)); cycStep(now,dt); cyc=true; }
  else if(RBC) for(const r of RBC) setCount(r,0);
  if(ON.personas&&mpp<PED_MPP*1.6){ if(redState==='none') loadRed(); if(calzState==='none') loadCalzada(); }
  let ped=false;
  if(ON.personas&&mpp<PED_MPP&&RED&&CALZ){ if(!PN) prepPed(); if(!PEDR) PEDR=PED_MODELS.map(m=>makeRenderer(m,PED_CAP)); pedFrame(now,dt); ped=true; }
  else if(PEDR){ for(const r of PEDR) setCount(r,0); nPed=nPedWait=0; }
  { const hi=mpp<HI_MPP; for(const r of [...(RC||[]),...(RB||[]),...(RP||[]),...(RBC||[])]){ for(const im of r.hi) im.visible=hi; for(const im of r.lo) im.visible=!hi; } }
  if(RP&&mpp>=PARK_MPP) for(const r of RP){ for(const im of r.hi) im.visible=false; for(const im of r.lo) im.visible=false; }
  if(PEDR){ const hi=mpp<PED_HI; for(const r of PEDR){ for(const im of r.hi) im.visible=hi; for(const im of r.lo) im.visible=!hi; } }
  anim=anim||cyc||ped;
  vehGroup.visible=anim; if(!anim||!BUS) hideBusLabels();
  if(now-lastPanel>2000){ lastPanel=now; if(anim||redState==='loading') panel(); }
  return anim||wxAnim;
}
window.__vivo={
  // para el test exhaustivo: forzar un clima y saltarse la transición suave
  wxModes:Object.keys(WX_SIMS), get wxSim(){ return wxSim; }, setWx:k=>setWxSim(k),
  setOn:(k,v)=>{ ON[k]=!!v; K.dirty(); panel(); }, get ON(){ return {...ON}; }, get peds(){ return peds; }, isRoad:(x,z)=>CALZ?isRoad(x,z):null, pedXY:p=>{ const o=new Float32Array(4); pedPos(p,o); return [o[0],o[1]]; },   // el test apaga y enciende capas sin tocar lo guardado
  wxSnap:()=>{ wxT=wxTarget(); for(const k in WXV) WXV[k]=wxT[k]; K.dirty(); },
  wx:()=>({...WXV,sim:wxSim,t:wxT,m1:wxM1.visible,m2:wxM2.visible,u:Object.fromEntries(Object.entries(wxMul.uniforms).map(([k,v])=>[k,typeof v.value==='number'?v.value:'·']))}),stats:()=>({lamps:lamps&&lamps.visible?nLamps:0,lmLights:lamps&&lamps.visible?nLmLights:0,ribbons:!!(ribbon&&ribbonGroup.visible),tramos:TRAF?TRAF.size:0,tramosState,bikeStations:BIKE&&BIKE.estaciones?BIKE.estaciones.length:0,bars:!!(bars&&bikeGroup.visible),wxM1:wxM1.visible,wxM2:wxM2.visible,manifest:!manifestErr,capas:manifest&&manifest.capas?Object.fromEntries(Object.entries(manifest.capas).map(([k,c])=>[k,c.estado||''])):{},cars:nCars,stopped:nStopped,parked:nParked,buses:nBuses,busAll:nBusAll,busLight:nBusLight,busJunc:nBusJunc,cyc:nCyc,cycLight:nCycLight,peds:nPed,pedWait:nPedWait,pedTarget,calzada:calzState,metro:nMetroAll,red:redState,bus:busState,bici:bkState,err:simErr,loadErr:{...LOADERR}}),get RED(){return RED;},get cand(){return cand;},get area(){return area;},get candTot(){return candTot;},get RC(){return RC;},get RB(){return RB;},get TRAF(){return TRAF;},get busActive(){return busActive;},get cycs(){return cycs;},get cyc(){ return {bkState,queue:cycQueue.length,cycs:cycs.length,area:cycArea,bike:!!BIKE,seen:cycSeen,ev:BIKE&&BIKE.eventos&&BIKE.eventos.length,rbc:!!RBC,cerca:cycs.filter(c=>c.x!==undefined).map(c=>[c.x,c.z,Math.hypot(c.x-cycArea.x,c.z-cycArea.z)]).sort((a,b)=>a[2]-b[2]).slice(0,3)}; },busXY(tr){ const o=new Float32Array(4); busPos(tr,secNow(),o); return [o[0],o[1]]; }};   // inspección
// Todo lo que hace falta para acercarse sin sorpresas se carga ya, y index.html mantiene la pantalla de carga hasta que
// termine (antes, si se hacía zoom en los primeros segundos, coches y personas arrancaban con datos a medio cargar)
K.listo=Promise.all([poll(),
  redState==='none'?loadRed():null, busState==='none'?loadBuses():null, bkState==='none'?loadBici():null,
  ON.personas&&calzState==='none'?loadCalzada():null]).catch(e=>console.warn('vivo: carga inicial',e));
setInterval(poll,POLL_MS); setInterval(panel,15000);
})();
