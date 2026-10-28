// Lógica compartida del juego (misma que la versión original): la ejecuta el SERVIDOR y el cliente solo usa constantes/estadísticas.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.Core=factory()})(this,function(){
'use strict';
const PW=640,LANES=4,LW=90,GOAL=10000,X0=(PW-LANES*LW)/2,MS=32;
const laneX=l=>X0+LW*(l+.5);
const TYPES={
 car:{n:'Coche',spd:6,res:2,w:44,l:78,man:8,wt:30},
 sport:{n:'Deportivo',spd:10,res:1,w:44,l:80,man:9,wt:12},
 moto:{n:'Moto',spd:9,res:1,w:22,l:56,man:14,wt:14},
 truck:{n:'Camión',spd:4,res:4,w:60,l:150,man:5,wt:12},
 tank:{n:'Tanque',spd:3,res:5,w:62,l:110,man:4,wt:6},
 armored:{n:'Blindado',spd:5,res:4,w:54,l:96,man:6,wt:8},
 bus:{n:'Autobús',spd:3,res:3,w:62,l:160,man:4,wt:10}};
const KEYS=Object.keys(TYPES),COLS=['#e84a4a','#f2c230','#8a6a4a','#e8e8f0','#d94fa0','#3aa8c9','#c9c93a'];
const maxSpd=k=>TYPES[k].spd*MS;
// Niveles: tráfico (n vehículos por fila, separación g+j) y pericia de la IA
const DIFF=[{n:[1,2],g:190,j:100,look:.75,err:.012,bad:.25,cd:.6},{n:[1,3],g:110,j:90,look:1,err:.004,bad:.08,cd:.35},{n:[2,3],g:60,j:60,look:1.3,err:.0008,bad:0,cd:.18}];
const CFG=[{n:'AZUL',c:'#2f9bff',b:'#2f7fd8'},{n:'VIOLETA',c:'#b45cff',b:'#8a3fd0'},{n:'VERDE',c:'#2fe08a',b:'#1f9a5c'},{n:'NARANJA',c:'#ff9a2f',b:'#d27414'}];
// ---------- Mundo compartido: tráfico + efectos ----------
class World{
 constructor(seed,d){this.s=seed;this.d=d;this.tr=[];this.ev=[];this.nid=1;this.nextY=320;this.free=1;this.spawnTo(1500)}
 rnd(){this.s=(this.s*1664525+1013904223)>>>0;return this.s/4294967296}
 pick(){let tot=0;for(const k of KEYS)tot+=TYPES[k].wt;let r=this.rnd()*tot;for(const k of KEYS){r-=TYPES[k].wt;if(r<=0)return k}return 'car'}
 // Cada fila deja siempre un carril libre; el carril libre solo se desplaza 1 y con más separación => nunca hay muro imposible
 spawnTo(lim){const D=DIFF[this.d];while(this.nextY<lim){let ex=0;if(this.rnd()<.35){this.free=Math.max(0,Math.min(3,this.free+(this.rnd()<.5?-1:1)));ex=100}
  const n=D.n[0]+(this.rnd()*(D.n[1]-D.n[0]+1)|0),ls=[0,1,2,3].filter(l=>l!==this.free).sort(()=>this.rnd()-.5).slice(0,n);let ml=0;
  for(const l of ls){const k=this.pick(),T=TYPES[k];ml=Math.max(ml,T.l);this.tr.push({id:this.nid++,t:k,lane:l,x:laneX(l),y:this.nextY+this.rnd()*20,base:T.spd*12*(.8+this.rnd()*.3),v:0,col:COLS[this.rnd()*COLS.length|0],dead:false,l:T.l,w:T.w})}
  this.nextY+=ml+D.g+this.rnd()*D.j+ex}}
 update(dt,minY,maxY){this.spawnTo(maxY+1300);const T=this.tr;
  for(const t of T){t.v=t.base;let lead=null;for(const o of T){if(o!==t&&o.lane===t.lane&&o.y>t.y&&(!lead||o.y<lead.y))lead=o}
   if(lead){const gap=lead.y-t.y-(t.l+lead.l)/2;if(gap<30)t.v=Math.min(t.base,lead.v);if(gap<2)t.y=lead.y-(t.l+lead.l)/2-2}
   t.y+=t.v*dt}
  this.tr=T.filter(t=>!t.dead&&t.y>minY-450);}
 // Los efectos visuales/sonoros los generan los clientes a partir de estos eventos (todos ven lo mismo)
 boom(x,y,n=40,big=1){this.ev.push(['boom',Math.round(x),Math.round(y),n,big])}
 ring(x,y,col){this.ev.push(['ring',Math.round(x),Math.round(y),col])}
 trail(x1,y1,x2,y2,col){this.ev.push(['trail',Math.round(x1),Math.round(y1),Math.round(x2),Math.round(y2),col])}
 snd(n){this.ev.push(['snd',n])}
}
// ---------- Corredor ----------
class Racer{
 constructor(id,cfg,human,world){const lane=[1,2,0,3][id];Object.assign(this,{id,name:cfg.n,col:cfg.c,body:cfg.b,human,world,type:'car',hp:TYPES.car.res,lane,inv:0,st:'drive',gt:0,expl:0,tp:0,shake:0,v:0,y:0,brake:false,target:null,ai:{cd:0,err:0}});this.x=laneX(lane)}
 get T(){return TYPES[this.type]}
 update(dt){this.inv=Math.max(0,this.inv-dt);this.shake=Math.max(0,this.shake-dt);
  if(this.st==='ghost'){this.gt+=dt;const h=this.target;if(h){this.v=h.v}else{this.y+=420*dt;this.v=420}if(this.gt>=.5){const t=h||this.findTarget();if(t)this.possess(t)}return}
  // velocidad automática: cada vehículo tiende a su velocidad máxima
  const mx=maxSpd(this.type);this.v+=((this.brake?mx*.25:mx)-this.v)*Math.min(1,(this.brake?4:2.5)*dt);this.y+=this.v*dt;this.x+=(laneX(this.lane)-this.x)*Math.min(1,this.T.man*dt);
  this.collide()}
 hit(dmg,t){this.hp-=dmg;this.v*=.55;this.shake=.3;if(this.hp<=0)this.destroy(t);else this.inv=.6}
 collide(){const T=this.T,w=this.world;if(this.inv>0)return;
  for(const t of w.tr){if(t.dead||t.held)continue;if(Math.abs(t.x-this.x)<(T.w*.9+t.w)/2&&Math.abs(t.y-this.y)<(T.l*.95+t.l)/2){
   const dmg=this.v-t.v>220?2:1;if(dmg<this.hp){t.dead=true;w.boom(t.x,t.y,16,.6)}w.snd('crash');this.hit(dmg,t);return}}}
 destroy(t){this.expl++;this.world.boom(this.x,this.y,70,1.4);this.world.snd('boom');this.st='ghost';this.gt=0;this.shake=.5;this.hp=0;this.target=t&&!t.dead?t:null;if(this.target)this.target.held=true}
 // Solo vehículos de tráfico vivos: nunca el vehículo que conduce el rival
 findTarget(){let best=null,bs=1e9;for(const t of this.world.tr){if(t.dead||t.held)continue;const dy=t.y-this.y;if(dy<=0||dy>700)continue;const s=dy+Math.abs(t.x-this.x)*.6;if(s<bs){bs=s;best=t}}return best}
 possess(t){const w=this.world;w.trail(this.x,this.y,t.x,t.y,this.col);w.ring(this.x,this.y,this.col);w.ring(t.x,t.y,this.col);
  t.dead=true;this.target=null;this.type=t.t;this.hp=TYPES[t.t].res;this.x=t.x;this.lane=t.lane;this.y=Math.max(this.y,t.y);this.v=Math.max(t.v,maxSpd(t.t)*.4);this.inv=2;this.st='drive';this.tp++;w.snd('tp')}}
function racerBump(a,b){if(a.st!=='drive'||b.st!=='drive'||a.inv>0||b.inv>0)return;
 if(Math.abs(a.x-b.x)<(a.T.w+b.T.w)*.45&&Math.abs(a.y-b.y)<(a.T.l+b.T.l)*.47){a.world.boom((a.x+b.x)/2,(a.y+b.y)/2,14,.6);a.world.snd('crash');a.hit(1);b.hit(1)}}

return {TYPES,KEYS,COLS,DIFF,CFG,maxSpd,LANES,LW,GOAL,X0,PW,MS,laneX,World,Racer,racerBump};
});
