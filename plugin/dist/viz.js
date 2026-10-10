// src/version.ts
var PLUGIN_VERSION = "0.1.1-preview";

// viz-asset:app.js
var app_default = '"use strict";(()=>{var Es=/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/g,Ss=/\\r\\n|[\\r\\n\\u{85}\\u{2028}\\u{2029}]/gu,Rs=/(?!\\n)[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u{E0000}-\\u{E007F}]/gu,vs=/[\\u{1B}\\u{90}\\u{98}\\u{9B}\\u{9D}\\u{9E}\\u{9F}]/u,Os=/^(?:\\s*\\/\\S*)+\\s*/u,ho="javascript|vbscript|data|blob|file|mailto",Ms=new RegExp(String.raw`(?<![A-Za-z0-9])(?:${ho}):\\S*`,"giu"),Cs=/(?<![A-Za-z0-9+.-])[A-Za-z0-9+.-]*:\\/\\/\\S*/gu,Ls=/[-\\u{2010}-\\u{2015}\\u{2212}\\u{FE58}\\u{FE63}\\u{FF0D}]{3,}/gu,ao="[link removed]",xs="＜",Ts="＞",Ds="—",po=27,Ps=7,Ns=156;function io(t,e){for(;e<t.length&&t.charCodeAt(e)>=48&&t.charCodeAt(e)<=63;)e++;for(;e<t.length&&t.charCodeAt(e)>=32&&t.charCodeAt(e)<=47;)e++;return e<t.length&&t.charCodeAt(e)>=64&&t.charCodeAt(e)<=126&&e++,e}function lo(t,e){for(;e<t.length;){let n=t.charCodeAt(e);if(n===Ps||n===Ns)return e+1;if(n===po)return t.charCodeAt(e+1)===92?e+2:e;e++}return e}function Vs(t){if(!vs.test(t))return t;let e=[],n=0,o=0;for(;o<t.length;){let r=t.charCodeAt(o),s=-1;if(r===po){let a=t.charCodeAt(o+1);if(a===91)s=io(t,o+2);else if(a===93||a===80||a===88||a===94||a===95)s=lo(t,o+2);else{let l=o+1;for(;l<t.length&&t.charCodeAt(l)>=32&&t.charCodeAt(l)<=47;)l++;s=l<t.length&&t.charCodeAt(l)>=48&&t.charCodeAt(l)<=126?l+1:o+1}}else r===155?s=io(t,o+1):(r===157||r===144||r===152||r===158||r===159)&&(s=lo(t,o+1));if(s<0){o++;continue}e.push(t.slice(n,o)),o=s,n=s}return e.push(t.slice(n)),e.join("")}function mo(t,e){let n=Vs(t.replace(Es,""));n=n.replace(Ss,`\n`).replace(Rs,"").normalize("NFC");let o=e==="claude"?`\n`:e==="notification"||e==="viz"?" ":"";return n=n.split(`\n`).map(r=>r.replace(Os,"")).join(o),n=n.normalize("NFC"),n=n.replace(/</g,xs).replace(/>/g,Ts),n=n.replace(Ms,ao).replace(Cs,ao),(e==="notification"||e==="viz")&&(n=n.replace(Ls,Ds)),n}var ln=Object.freeze({name:20,label:80,path:80,note:280,branch:80,room:40,card:400,tooltip:200,plaque:16,caption:120,version:20}),Us=64,Zs=Object.freeze(Object.fromEntries(Object.keys(ln).map(t=>[t,t==="name"?Us:4*ln[t]]))),co=4,Fs=new Set(["path","plaque","label"]),Bs=new RegExp(String.raw`^(?:${ho}):`,"iu"),uo="…",go=new Intl.Segmenter("en",{granularity:"grapheme"}),bo=new RegExp("\\\\p{M}","u");function fo(t){let e=!1,n=[];for(let{segment:o}of go.segment(t)){if(o.length<=co){n.push(o);continue}let r=0,s="";for(let a of o){if(bo.test(a)&&++r>co){e=!0;continue}s+=a}n.push(s)}return e?n.join(""):null}function zs(t){if(!bo.test(t))return t;let e=t;for(let n=fo(e);n!==null;n=fo(e))e=n;return e}function an(t,e,n,o,r){let s=0,a=0;for(let l=e;l>=0&&l<t.length&&s<o;l+=n){let c=t[l].length;if(a+c>r)break;a+=c,s+=1}return{n:s,units:a}}function cn(t,e){let n=ln[e],o=Zs[e],r=zs(t);if(r.length<=n)return r;let s=Array.from(go.segment(r),h=>h.segment);if(s.length<=n&&r.length<=o)return r;let a=n-1,l=o-1;if(!Fs.has(e))return s.slice(0,an(s,0,1,a,l).n).join("")+uo;let c=an(s,0,1,Math.floor(a/2),Math.floor(l/2)),f=an(s,s.length-1,-1,a-c.n,l-c.units),d=s.length-f.n;for(;d<s.length&&Bs.test(s.slice(d).join(""));)d+=1;return s.slice(0,c.n).join("")+uo+s.slice(d).join("")}var Ue=Object.freeze(["en","ko","zh-CN","ja","fr","es"]),Hs=Object.freeze({terminal:null,slash:4e3,systemMessage:1050,notification:120,json:null,log:null,viz:400}),js={terminal:"terminal",slash:"terminal",systemMessage:"terminal",notification:"notification",json:"terminal",log:"log",viz:"viz"},Gs={name:"name",path:"path",label:"label",id:"label",note:"note",text:"card"},qs=new Set(["name","path","label","id","n","dur","cmd","reason","note","code","text","url"]),wo=/^[A-Z][A-Z0-9_]{2,47}$/,Ks=/^http:\\/\\/127\\.0\\.0\\.1:[1-9][0-9]{0,4}\\/#k=[0-9a-f]{64}$/;var $s=/\\{([a-z][a-z0-9_]*)\\}/g,Ws=/[\\p{Cc}\\p{Cf}]/gu,Ys="[link removed]",Ve="?",Xs=new Intl.Segmenter("en",{granularity:"grapheme"});var $e=(t,e)=>Object.prototype.hasOwnProperty.call(t,e)?t[e]:void 0;function Js(t){if(typeof t!="object"||t===null||typeof t.text!="string")return!1;let e=t;return!(e.params!==void 0&&(typeof e.params!="object"||e.params===null||!Object.values(e.params).every(n=>typeof n=="string"&&qs.has(n)))||e.plural!==void 0&&typeof e.plural!="string"||e.forms!==void 0&&(typeof e.forms!="object"||e.forms===null||!Object.values(e.forms).every(n=>typeof n=="string")))}var _o=new Map,Ao=new Map;function Qs(t){let e=_o.get(t);return e===void 0&&(e=new Intl.NumberFormat(t),_o.set(t,e)),e}function ea(t){let e=Ao.get(t);return e===void 0&&(e=new Intl.PluralRules(t),Ao.set(t,e)),e}var Mt=t=>typeof t=="number"&&Number.isFinite(t);function ta(t,e){let{e:n}=t;if(n.plural===void 0||n.forms===void 0)return n.text;let o=$e(e,n.plural);if(!Mt(o))return n.text;let r=$e(n.forms,ea(t.lang).select(o))??$e(n.forms,"other");return typeof r=="string"?r:n.text}function na(t,e){let n=Math.round(e/1e3),o=Math.round(e/6e4),[r,s]=n<60?["UI_DUR_S",n]:o<60?["UI_DUR_MIN",o]:["UI_DUR_H",Math.round(e/36e5)],a=t.look(t.lang,r);return a===null?Ve:_t(t,a,{n:s},1)}function oa(t,e,n,o,r){let s=e.params===void 0?void 0:$e(e.params,o),a=$e(n,o);switch(s){case"n":return Mt(a)?Qs(t.lang).format(a):Ve;case"dur":return Mt(a)&&a>=0?na(t,a):Ve;case"reason":{if(r>0||typeof a!="string"||!t.reasons.has(a))return Ve;let l=t.look(t.lang,a);return l===null?Ve:_t(t,l,n,r+1)}case"url":return t.channel==="terminal"&&typeof a=="string"&&Ks.test(a)?a:Ys;case"cmd":return typeof a=="string"?a.replace(Ws,""):Ve;case"code":return typeof a=="string"&&wo.test(a)?a:Ve;case"name":case"path":case"label":case"id":case"note":case"text":return typeof a!="string"&&!Mt(a)?Ve:cn(mo(String(a),js[t.channel]),Gs[s]);default:return Ve}}function _t(t,e,n,o){return ta(e,n).replace($s,(r,s)=>oa(t,e.e,n,s,o))}function yo(t){let e=t.look(t.lang,"UI_INTERNAL_ERROR");return e===null?Ve:_t(t,e,{},1)}var ra=t=>{let e=0;for(let n of Xs.segment(t))e+=1;return e};function sa(t,e,n,o,r,s){let a={look:t,reasons:e,channel:r,lang:s},l=t(s,n),c=l===null?yo(a):_t(a,l,o,0);if(r==="viz")return cn(c,"card");let f=Hs[r];if(f===null||ra(c)<=f)return c;let d=t(s,"UI_TEXT_TOO_LONG");return d===null?yo(a):_t(a,d,{code:n},1)}function ko(t,e,n,o,r,s){let a=(c,f)=>{let d=$e(t,c),h=typeof d=="object"&&d!==null?$e(d,f):void 0;return Js(h)?{e:h,lang:c}:null};return sa((c,f)=>wo.test(f)?a(c,f)??a("en",f):null,e,n,o,r,s)}var aa=["room_open","person_enter","person_respawn","pet_poof","claim_release","person_badge","person_exit","pet_spawn","publish","room_sign","person_freeze","person_thaw","person_slowed","room_badge","person_bang","conflict","box","claim_take","claim_move","claim_stale","claim_reserve","grant_start","grant_end","request_open","request_status","answer","note","person_absent","save","person_ghost","person_unghost","pose_relaxed"];var Hl=Object.freeze([...aa]);function j(t){return"peer"in t?`p:${t.peer}`:`s:${t.seat}`}var Ro="…";var fn="⌂";var de=Object.freeze({x:1,y:0}),vo=17,Oo=20,Mo=1,Co=2,ia={x:18,y:3},la=[{x:16,y:3},{x:17,y:3},{x:19,y:3},{x:20,y:3}],Io=[{x:0,y:1},{x:0,y:2},{x:0,y:3},{x:1,y:2},{x:1,y:3}],Eo=8,un=3,dn=3;function ca(t){return Object.freeze({ordinal:t.ordinal,key:t.key,kind:t.kind,zone:t.zone,cell:t.cell,slot:t.slot,path:t.path,lockbox:t.lockbox??!1,first:t.first})}var Gl=ca({ordinal:0,key:fn,kind:"big_table",zone:null,cell:null,slot:null,path:null,first:0});function ua(t){let e=0;for(let n of t.zones)e+=n.cells.length;return e}function We(t){return{w:21,h:4+10*Math.ceil(ua(t)/3)}}function Lo(t){if(!Number.isSafeInteger(t)||t<0)throw new RangeError(`homeTile: not a home spot ${t}`);if(t<16)return{x:2+2*(t%Eo),y:1+Math.floor(t/Eo)};let e=Io[(t-16)%Io.length];return{x:e.x,y:e.y}}function st(t){return{x:7*(t%3),y:4+10*Math.floor(t/3)}}function da(t,e){let n=st(t);return{x:n.x+un*(e%2),y:n.y+1+dn*Math.floor(e/2)}}function we(t,e){let n=Number.isSafeInteger(e)&&e>=0?t.desks[e]:void 0;if(n===void 0)throw new RangeError(`deskTiles: no desk ${e}`);if(n.kind==="big_table"){let s=[];for(let a=Mo;a<=Co;a++)for(let l=vo;l<=Oo;l++)s.push({x:l,y:a});return{desk:s,chair:{...ia},visitors:la.map(a=>({...a}))}}if(n.cell===null||n.slot===null)throw new RangeError(`deskTiles: desk ${e} has no slot`);let{x:o,y:r}=da(n.cell,n.slot);return{desk:[{x:o,y:r},{x:o+1,y:r}],chair:{x:o,y:r+1},visitors:[{x:o+1,y:r+1},{x:o+2,y:r+1},{x:o,y:r+2},{x:o+1,y:r+2}]}}var So=new WeakMap;function fa(t){let e=So.get(t);if(e!==void 0&&e.n===t.length)return e.slots;let n=new Set;for(let o of t)o.cell!==null&&o.slot!==null&&n.add(o.cell*6+o.slot);return So.set(t,{n:t.length,slots:n}),n}function at(t,e){let{x:n,y:o}=e;if(!Number.isSafeInteger(n)||!Number.isSafeInteger(o)||n<0||o<0||n>=21||o>=We(t).h)return!0;if(o===0)return n!==de.x;if(o<4)return n>=vo&&n<=Oo&&o>=Mo&&o<=Co;let r=n%7,s=(o-4)%10;if(s===0||r===6)return!1;let a=s-1;if(a%dn!==0||r%un===2)return!1;let l=Math.floor(n/7)+3*Math.floor((o-4)/10),c=Math.floor(r/un)+2*Math.floor(a/dn);return fa(t.desks).has(l*6+c)}function xo(t,e){return e!==null&&t.first>e.height}function Me(t,e){return t.height!==e.height?t.height<e.height?-1:1:t.sub!==e.sub?t.sub<e.sub?-1:1:t.k!==e.k?t.k<e.k?-1:1:0}function pn(t,e){let n=t.homeOrder.indexOf(e);return n>=0?n:t.homeOrder.length}function ha(t){let e={requestsFrom:new Map,newestHeld:new Map,stoolDesks:new Map,petsOf:new Map};for(let[n,o]of t.requests)hn(e.requestsFrom,j(o.from),{id:n,holder:o.holder,desk:o.desk});for(let n of t.claims.values()){if(!n.stale){let o=e.newestHeld.get(n.seat);(o===void 0||Me(n.at,o.at)>0)&&e.newestHeld.set(n.seat,{desk:n.desk,at:n.at})}n.grantee!==null&&pa(e.stoolDesks,j(n.grantee),n.desk)}for(let[n,o]of t.pets)o.live&&hn(e.petsOf,o.owner,[n,o]);return e}function hn(t,e,n){let o=t.get(e);o===void 0?t.set(e,[n]):o.push(n)}function pa(t,e,n){let o=t.get(e);o===void 0?t.set(e,new Set([n])):o.add(n)}var Ct=t=>"peer"in t?{peer:t.peer}:{seat:t.seat},Do=(t,e)=>j(t)===j(e);function ma(t){return t.at==="home"||t.at==="behind"?null:t.desk}function Po(t,e,n,o){if(n!==null&&e.has(n))return n;if(o!==null&&e.has(o))return o;let r=null,s=-1/0;for(let a of e){let l=t.desks.get(a)?.lastEvent??-1;(r===null||l>s||l===s&&a<r)&&(r=a,s=l)}return r}function No(t,e,n,o){let r=t.requestsFrom.get(e);if(r===void 0)return null;if(o!==null&&o.actor===e&&o.kind==="face"){let s=r.find(a=>a.id===o.request);if(s!==void 0)return{at:"facing",actor:Ct(s.holder),desk:s.desk}}if(n.at==="facing"){let s=n,a=r.find(l=>l.desk===s.desk&&Do(l.holder,s.actor));if(a!==void 0)return{at:"facing",actor:Ct(a.holder),desk:a.desk}}return null}function ga(t,e,n,o,r){if(!o.live)return{place:{at:"behind",peer:o.owner}};let s=j({seat:n}),a=No(e,s,o.place,r);if(a!==null)return{place:a};let l=e.newestHeld.get(n);if(l!==void 0)return{desk:l.desk};let c=e.stoolDesks.get(s);return c!==void 0?{place:{at:"stool",desk:Po(t,c,r!==null&&r.actor===s&&r.kind==="stool"?r.desk:null,o.place.at==="stool"?o.place.desk:null)}}:o.lastDesk!==null?{desk:o.lastDesk}:{place:{at:"behind",peer:o.owner}}}function ba(t,e,n,o,r,s,a){let l={place:{at:"home",spot:pn(n,o)}};if(r.absent||r.ghost)return l;let c=No(e,j({peer:o}),r.place,a);if(c!==null)return{place:c};let f=e.petsOf.get(o)??[];if(r.lastPublish!==null&&r.lastDesk!==null){let d=r.lastPublish;if(f.every(([,h])=>h.lastClaimOp===null||Me(d,h.lastClaimOp)>0))return{desk:r.lastDesk}}if(f.some(([d])=>e.newestHeld.has(d))){let d=new Map;for(let[w]of f){let A=s.get(j({seat:w})),S=A===void 0?null:"desk"in A?A.desk:A.place.at==="stool"?A.place.desk:null;S!==null&&d.set(S,(d.get(S)??0)+1)}let h=0;for(let w of d.values())w>h&&(h=w);if(h>0){let w=new Set([...d.keys()].filter(A=>d.get(A)===h));return{place:{at:"beside",desk:Po(t,w,null,r.place.at==="beside"?r.place.desk:null)}}}}return l}function _a(t,e){let n=new Map;for(let o of t.claims.values()){if(o.stale||o.desk!==e)continue;let r=n.get(o.seat);(r===void 0||Me(o.at,r)>0)&&n.set(o.seat,o.at)}return n}function Aa(t,e,n){let o=_a(t,e),r=d=>"peer"in d?t.characters.get(d.peer):t.pets.get(d.seat),s=(d,h)=>d===null?h===null?0:1:h===null?-1:Me(h,d),a=(d,h)=>{let w="seat"in d?t.pets.get(d.seat)?.variant??0:-1,A="seat"in h?t.pets.get(h.seat)?.variant??0:-1;if(w!==A)return w-A;let S=j(d),g=j(h);return S<g?-1:S>g?1:0},l=d=>"seat"in d?o.get(d.seat)??null:null,c=n.filter(d=>l(d)!==null),f=n.filter(d=>l(d)===null);return c.sort((d,h)=>s(l(d),l(h))||a(d,h)),f.sort((d,h)=>s(r(d)?.lastPublish??null,r(h)?.lastPublish??null)||a(d,h)),[...c,...f]}var To=4;function ya(t){let e=t.slice(1);return{chair:t[0]===void 0?null:Ct(t[0]),visitors:e.slice(0,To).map(Ct),more:Math.max(0,e.length-To)}}function wa(t,e){return e===0?{at:"chair",desk:t}:{at:"visitor",desk:t,tile:e-1}}var ka=t=>t.at==="chair"||t.at==="stool"?"sit":"idle";function Ia(t,e){switch(t.at){case"home":return e.at==="home"&&t.spot===e.spot;case"behind":return e.at==="behind"&&t.peer===e.peer;case"visitor":return e.at==="visitor"&&t.desk===e.desk&&t.tile===e.tile;case"facing":return e.at==="facing"&&t.desk===e.desk&&Do(t.actor,e.actor);default:return e.at===t.at&&ma(e)===t.desk}}var Ea=()=>({lastEvent:null,chair:null,visitors:[],more:0,claims:[]});function Vo(t,e,n,o){let r=ha(t),s=new Map;for(let[d,h]of t.pets)h.live&&s.set(j({seat:d}),ga(t,r,d,h,n));for(let[d,h]of t.characters)s.set(j({peer:d}),ba(t,r,e,d,h,s,n));let a=new Map,l=(d,h,w)=>{let A=s.get(d);"desk"in A&&hn(a,A.desk,w?{peer:h}:{seat:h})};for(let d of t.characters.keys())l(j({peer:d}),d,!0);for(let[d,h]of t.pets)h.live&&l(j({seat:d}),d,!1);let c=new Map;for(let[d,h]of s)"place"in h&&c.set(d,h.place);for(let[d,h]of a){let w=Aa(t,d,h);w.forEach((S,g)=>c.set(j(S),wa(d,g)));let A=t.desks.get(d)??Ea();Object.assign(A,ya(w)),t.desks.set(d,A)}for(let[d,h]of t.desks)a.has(d)||Object.assign(h,{chair:null,visitors:[],more:0}),h.lastEvent===null&&h.chair===null&&h.visitors.length===0&&h.claims.length===0&&t.desks.delete(d);let f=(d,h)=>{let w=c.get(d),A=!Ia(h.place,w);h.place=w,(A||d===o)&&(h.pose=ka(w))};for(let[d,h]of t.characters)f(j({peer:d}),h);for(let[d,h]of t.pets)h.live&&f(j({seat:d}),h)}var Fo=64;var Sa=256;function Ra(t){return{at:{height:t.height,sub:t.sub,k:t.k},badge:"none",branchMovedAt:null,characters:new Map,pets:new Map,desks:new Map,claims:new Map,requests:new Map,boxes:new Map,bangs:new Map,beat:[]}}function Lt(t){return structuredClone(t)}var Ye=t=>({height:t.height,sub:t.sub,k:t.k}),it=t=>"peer"in t?{peer:t.peer}:{seat:t.seat};function Bo(t,e){let n=t.desks.get(e);return n===void 0&&(n={lastEvent:null,chair:null,visitors:[],more:0,claims:[]},t.desks.set(e,n)),n}function De(t,e,n){e!==null&&(Bo(t,e).lastEvent=n)}function Uo(t,e,n){let o=t.desks.get(n);o!==void 0&&(o.claims=o.claims.filter(r=>r!==e))}function va(t,e,n){let o=Bo(t,n.desk),r=a=>{let l=t.claims.get(a);return l!==void 0&&(l.order<n.order||l.order===n.order&&Me(l.at,n.at)<0)},s=0;for(;s<o.claims.length&&r(o.claims[s]);)s++;o.claims.splice(s,0,e)}function Zo(t,e){if("peer"in e)return t.characters.get(e.peer);let n=t.pets.get(e.seat);return n!==void 0&&n.live?n:void 0}function lt(t,e,n){let o=t.characters.get(e);o!==void 0&&n(o)}function zo(t,e,n){e.height!==t.at.height&&(t.beat=[]),t.beat.push(structuredClone(e)),t.at=Ye(e);let o=null,r=null;switch(e.kind){case"room_open":case"person_bang":case"note":case"pose_relaxed":break;case"room_sign":t.branchMovedAt=e.height;break;case"room_badge":t.badge=e.level;break;case"person_enter":case"person_respawn":{let s=t.characters.get(e.peer);s===void 0?t.characters.set(e.peer,{place:{at:"home",spot:pn(n,e.peer)},pose:"idle",lastPublish:null,lastDesk:null,lastClaimOp:null,ghost:!1,absent:!1,frozen:null,slowedUntil:null,rules:!1,credit:!1}):Object.assign(s,{absent:!1,ghost:!1,lastPublish:null,lastDesk:null,lastClaimOp:null}),r=j({peer:e.peer});break}case"person_exit":t.characters.delete(e.peer);break;case"person_absent":lt(t,e.peer,s=>{s.absent=!0});break;case"person_ghost":lt(t,e.peer,s=>{s.ghost=!0});break;case"person_unghost":lt(t,e.peer,s=>{s.ghost=!1});break;case"person_freeze":lt(t,e.peer,s=>{s.frozen=e.reasonCode});break;case"person_thaw":lt(t,e.peer,s=>{s.frozen=null});break;case"person_slowed":lt(t,e.peer,s=>{s.slowedUntil=e.until});break;case"person_badge":if("peer"in e.actor){let s=t.characters.get(e.actor.peer);s!==void 0&&e.badge==="rules"&&(s.rules=e.on),s!==void 0&&e.badge==="credit"&&(s.credit=e.on)}else if(e.badge==="health"){let s=t.pets.get(e.actor.seat);s!==void 0&&s.live&&(s.ssCode=e.on?e.code:null)}break;case"pet_spawn":{let s=t.pets.get(e.seat);if(s===void 0){let a=0;for(let l of t.pets.values())l.owner===e.owner&&a++;t.pets.set(e.seat,{place:{at:"behind",peer:e.owner},pose:"idle",lastPublish:null,lastDesk:null,lastClaimOp:null,owner:e.owner,variant:a,live:!0,ssCode:null}),r=j({seat:e.seat})}else s.live||(Object.assign(s,{owner:e.owner,live:!0,ssCode:null,lastPublish:null,lastDesk:null,lastClaimOp:null}),r=j({seat:e.seat}));break}case"pet_poof":{let s=t.pets.get(e.seat);s!==void 0&&s.live&&Object.assign(s,{live:!1,ssCode:null,place:{at:"behind",peer:s.owner},pose:"idle"});break}case"publish":{let s=Zo(t,e.actor);s!==void 0&&(s.lastPublish=Ye(e),s.lastDesk=e.target,r=j(e.actor)),De(t,e.target,e.height);for(let a of e.others)De(t,a,e.height);break}case"conflict":e.source==="hold"&&e.holdId!==null&&t.bangs.set(e.holdId,{on:it(e.on),desk:e.desk}),De(t,e.desk,e.height);break;case"box":e.terminal?(t.boxes.delete(e.holdId),t.bangs.delete(e.holdId)):t.boxes.set(e.holdId,{owner:it(e.owner),desk:e.desk,holdKind:e.holdKind,residence:e.residence,state:e.state,localOnly:e.localOnly}),De(t,e.desk,e.height);break;case"claim_take":case"claim_move":{let s=t.claims.get(e.claimId);s!==void 0&&(Uo(t,e.claimId,s.desk),De(t,s.desk,e.height));let a={seat:e.seat,desk:e.desk,order:e.order,label:e.label===null?null:{simple:e.label.simple,qualname:e.label.qualname},granularity:e.granularity,lines:e.lines===null?null:[e.lines[0],e.lines[1]],stale:!1,reservedFor:s?.reservedFor??null,grantee:s===void 0||s.grantee===null?null:it(s.grantee),otherRules:e.otherRules,at:Ye(e)};t.claims.set(e.claimId,a),va(t,e.claimId,a),De(t,e.desk,e.height);let l=t.pets.get(e.seat);l!==void 0&&l.live&&(l.lastClaimOp=Ye(e)),r=j({seat:e.seat});break}case"claim_stale":{let s=t.claims.get(e.claimId);s!==void 0&&(s.stale=!0,De(t,s.desk,e.height));break}case"claim_release":{let s=t.claims.get(e.claimId);s!==void 0&&(t.claims.delete(e.claimId),Uo(t,e.claimId,s.desk),De(t,s.desk,e.height));break}case"claim_reserve":{let s=t.claims.get(e.claimId);s!==void 0&&(s.reservedFor=e.request,De(t,s.desk,e.height));break}case"grant_start":case"grant_end":{let s=t.claims.get(e.claimId);s!==void 0&&(s.grantee=e.kind==="grant_start"?it(e.grantee):null,De(t,s.desk,e.height),e.kind==="grant_start"&&(o={actor:j(e.grantee),kind:"stool",desk:s.desk},r=o.actor));break}case"request_open":t.requests.set(e.request,{from:it(e.from),holder:it(e.holder),desk:e.desk,status:null}),De(t,e.desk,e.height),o={actor:j(e.from),kind:"face",request:e.request},r=o.actor;break;case"request_status":{let s=t.requests.get(e.request);s!==void 0&&e.status==="returned"?t.requests.delete(e.request):s!==void 0&&(s.status=e.status);break}case"answer":e.verb!=="later"&&t.requests.delete(e.request);break;case"save":for(let s of e.desks)De(t,s,e.height);break}if(Vo(t,n,o,r),e.kind==="pose_relaxed"){let s=Zo(t,e.actor);s!==void 0&&(s.pose="relaxed")}}var Xe=class{s;layout;last;constructor(e,n){this.s=Lt(e),this.layout=n;let o=e.beat.at(-1);this.last=o===void 0?null:Ye(o)}push(e){if(this.last!==null&&Me(e,this.last)<=0||Me(e,this.s.at)<0)throw new RangeError(`SceneReducer.push: the event at ${e.height}.${e.sub}.${e.k} is not after ${this.s.at.height}.${this.s.at.sub}.${this.s.at.k}`);let n=Lt(this.s);zo(n,e,this.layout()),this.s=n,this.last=Ye(e)}scene(){return Lt(this.s)}};function Oa(t,e){let n=0,o=t.length;for(;n<o;){let r=n+o>>>1;t[r].height>e?o=r:n=r+1}return n}function mn(t,e){let n=t.segments;if(n.length===0)return Ra(e);let o=0;for(let a=0;a<n.length;a++)n[a].hs<e.height&&(o=a);let r=o+1<n.length?n[o+1].hs:1/0,s=Lt(n[o].start);for(let a=o===0?0:Oa(t.events,n[o].hs);a<t.events.length;a++){let l=t.events[a];if(l.height>r||Me(l,e)>0)break;zo(s,l,t.layout)}return Me(e,s.at)>0&&(e.height!==s.at.height&&(s.beat=[]),s.at=Ye(e)),s}function Ho(t,e){let n=t.desks.get(e)?.lastEvent??null;return n!==null&&t.at.height-n>=Sa}function At(t,e,n){let o="peer"in e?t.characters.get(e.peer):t.pets.get(e.seat);if(o===void 0||"seat"in e&&!t.pets.get(e.seat).live)return null;let r=o.place;if(r.at!=="chair"&&r.at!=="stool")return null;let s=r.desk;if("seat"in e){let a=t.desks.get(s)?.claims??[],l=null;for(let c of t.claims.values())c.stale||c.seat!==e.seat||c.desk!==s||(l===null||Me(c.at,l.at)>0)&&(l=c);if(l!==null){let c=l.label;return c===null?{code:"UI_VIZ_HOLDING",label:null}:{code:"UI_VIZ_HOLDING",label:a.some(d=>{let h=t.claims.get(d);return h!==void 0&&h!==l&&h.label!==null&&h.label.simple===c.simple})?c.qualname:c.simple}}}return o.lastPublish!==null&&o.lastDesk===s?{code:"UI_VIZ_LAST_SHARED_HERE",path:n.desks[s]?.path??null,height:o.lastPublish.height}:null}var Ma=Object.freeze(["UI_VIZ_DEMO_CAPTION_1","UI_VIZ_DEMO_CAPTION_2","UI_VIZ_DEMO_CAPTION_3","UI_VIZ_DEMO_CAPTION_4","UI_VIZ_DEMO_CAPTION_5"]),jo=["PH_OK","PH_OFFLINE","PH_PAUSED","PH_FROZEN","PH_NOT_COORDINATED","PH_PRESUMED_ABSENT","PH_LEFT","PH_SLOWED"],Go=["SS_FULL","SS_HOOK_ONLY","SS_NO_MCP","SS_NO_HOOKS","SS_DEGRADED","SS_PAUSED","SS_PULL_MODE"],Ca=Object.freeze({cli:Object.freeze(["UI_VIZ_OPENED","UI_VIZ_URL","UI_VIZ_OPEN_FAILED","UI_VIZ_TERMINAL_ONLY","RF_VIZ_START_FAILED","RF_VIZ_BIND_FAILED","RF_VIZ_NO_ROOMS","RF_VIZ_REPO_NOT_LIVE","RF_VIZ_DEMO_INVALID"]),page:Object.freeze(["UI_VIZ_STOPPED","UI_VIZ_LINK_EXPIRED","UI_VIZ_LINK_REUSED","UI_VIZ_NEED_LINK","UI_VIZ_BAD_HOST","UI_VIZ_NOT_FOUND","UI_VIZ_NO_ROOMS","UI_VIZ_ROOM_AMBIGUOUS","UI_VIZ_ROOM_DOWN","UI_VIZ_ROOM_GONE","UI_VIZ_NO_BOARD","UI_VIZ_RECONNECTING","UI_VIZ_VERSION_SKEW","UI_VIZ_NEWER_PROTOCOL","UI_VIZ_CHECKPOINT_MISMATCH","UI_VIZ_INCIDENT_FROZEN","UI_VIZ_STATUS_UNREADABLE","UI_VIZ_LAST_FETCH","UI_VIZ_BOARD_FULL","UI_VIZ_BOARD_NEAR_FULL","UI_VIZ_DEMO_BANNER",...Ma,"UI_VIZ_CAUGHT_UP","UI_VIZ_NEW_PILL","UI_VIZ_MORE","UI_VIZ_SEEN_AGO","UI_VIZ_SEEN_BEFORE_OPEN"]),scene:Object.freeze(["UI_VIZ_YOU","UI_VIZ_LAST_SHARED_HERE","UI_VIZ_HOLDING","UI_VIZ_SHELF_DESK","UI_VIZ_BIG_TABLE","UI_VIZ_GRANT_PAUSE","UI_VIZ_HOST_REFUSED","UI_VIZ_LABEL_UNVERIFIED","UI_VIZ_SCENE_SUMMARY","UI_VIZ_SIGN_BASE_MOVE","UI_VIZ_TAG_RESERVED","UI_VIZ_TAG_LINES","UI_VIZ_TAG_CHECKS","UI_VIZ_CHIP_ASKED_AGAIN","UI_VIZ_BUBBLE_GO_FIRST","UI_VIZ_BADGE_VERSION","UI_VIZ_BADGE_RULES","UI_VIZ_BADGE_CREDIT","UI_VIZ_BADGE_HEALTH"]),icon:Object.freeze(["UI_VIZ_ICON_QUEUED","UI_VIZ_ICON_ASKED","UI_VIZ_ICON_AWAITING_HUMAN","UI_VIZ_ICON_UNDELIVERABLE","UI_VIZ_ICON_ACCEPTED","UI_VIZ_ICON_DECLINED","UI_VIZ_ICON_LATER","UI_VIZ_ICON_DAEMON","UI_VIZ_ICON_WAKE"]),card:Object.freeze(["UI_VIZ_CARD_ROOM_OPEN","UI_VIZ_CARD_JOIN","UI_VIZ_CARD_REJOIN","UI_VIZ_CARD_LEAVE","UI_VIZ_CARD_SEAT_START","UI_VIZ_CARD_SEAT_END","UI_VIZ_CARD_REQUEST","UI_VIZ_CARD_ANSWER","UI_VIZ_CARD_NOTE","UI_VIZ_CARD_K4","UI_VIZ_CARD_CONFLICT","UI_VIZ_CARD_BREACH","UI_VIZ_CARD_ABSENT","UI_VIZ_CARD_SAVE","UI_VIZ_CARD_FREEZE","UI_VIZ_CARD_THAW","UI_VIZ_CARD_SLOWED","UI_VIZ_CARD_NONRETRYABLE","UI_VIZ_CARD_BASE_MOVE","UI_VIZ_CARD_BOARD_FULL","UI_VIZ_CARD_VERSION","UI_VIZ_CARD_RULES","UI_VIZ_CARD_HEALTH","UI_VIZ_CARD_PUBLISH"]),recording:Object.freeze(["UI_VIZ_RECORD_NOTICE","UI_VIZ_RECORD_UNSUPPORTED","UI_VIZ_RECORD_CAP","UI_VIZ_RECORD_SIZE","UI_VIZ_RECORD_INTERRUPTED","UI_VIZ_ANON_ROOM","UI_VIZ_ANON_NAME_APRICOT","UI_VIZ_ANON_NAME_AMBER","UI_VIZ_ANON_NAME_SKY","UI_VIZ_ANON_NAME_GREEN","UI_VIZ_ANON_NAME_LEMON","UI_VIZ_ANON_NAME_BLUE","UI_VIZ_ANON_NAME_PINK","UI_VIZ_ACC_BEANIE","UI_VIZ_ACC_HEADPHONES","UI_VIZ_ACC_SUNGLASSES","UI_VIZ_ACC_SCARF","UI_VIZ_ACC_SPROUT","UI_VIZ_ACC_CAP","UI_VIZ_ACC_BOW","UI_VIZ_ACC_GLASSES"]),control:Object.freeze(["UI_VIZ_CTRL_PLAY","UI_VIZ_CTRL_PAUSE","UI_VIZ_CTRL_LIVE","UI_VIZ_CTRL_SPEED","UI_VIZ_CTRL_LOAD_EARLIER","UI_VIZ_CTRL_RECORD","UI_VIZ_CTRL_REDUCED_MOTION","UI_VIZ_CTRL_LANGUAGE","UI_VIZ_CTRL_ZOOM","UI_VIZ_CTRL_COARSE","UI_VIZ_CTRL_ANONYMIZE","UI_VIZ_FILTER_ALL","UI_VIZ_FILTER_PERSON","UI_VIZ_FILTER_FILE","UI_VIZ_FILTER_CONVERSATION","UI_VIZ_FILTER_ACTIVITY","UI_VIZ_FILTER_CONFLICTS","UI_VIZ_FILTER_SYSTEM"]),log:Object.freeze(["SEC_VIZ_BAD_HOST","SEC_VIZ_BAD_ORIGIN","SEC_VIZ_BAD_TOKEN","SEC_VIZ_LAUNCH_REUSED","SEC_VIZ_LAUNCH_EXPIRED","SEC_VIZ_METHOD","SEC_VIZ_LIMIT","VIZ_EXIT_IDLE","VIZ_EXIT_LIFETIME","VIZ_EXIT_LAUNCH_UNUSED","VIZ_EXIT_LAUNCH_REUSED","VIZ_EXIT_PLUGIN_REMOVED","VIZ_EXIT_SIGNAL","VIZ_LOG_DROPPED"]),reused:Object.freeze([...jo,...Go,"UI_DUR_S","UI_DUR_MIN","UI_DUR_H","UI_INTERNAL_ERROR","SEC_SECRET_REDACTED","SEC_RECORD_INVALID","SEC_REFUSE_RUNTIME_INTEGRITY","RF_UNKNOWN_FLAG","START_TOOL_VERSION"])}),La=new Set(Object.values(Ca).flat()),xa=Object.freeze(["UI_VIZ_","PH_","SS_","UI_DUR_"]),Ta=new Set(["EPOCH","MASS","PAUSED","INCIDENT","CONFIG","NOHOOKS"]),Da=new Set(["HOST_THROTTLED","BOARD_FULL"]),Pa=new Set(["OFFLINE","AUTH","NONRETRYABLE","VERSION"]);var qo=new Set(jo),Ko=new Set(Go);var gn=new Set([...Ta,...Da,...Pa]),nc=new Set([...[...La].filter(t=>xa.some(e=>t.startsWith(e))),...gn,"UI_INTERNAL_ERROR"]);var be=(t,e,n,o)=>Object.freeze({frames:t,frameMs:e,durationMs:n,reduced:o}),rc=Object.freeze({idle:be(2,600,null,"off"),walk:be(4,100,null,"crossfade"),sit:be(2,140,null,"icon"),sparkle_small:be(4,100,400,"icon"),sparkle_big:be(6,100,600,"icon"),planes:be(6,100,600,"icon"),exclaim:be(2,350,700,"static"),think:be(3,350,null,"static"),bubble:be(1,200,null,"static"),zzz:be(3,600,null,"static"),relaxed:be(2,900,null,"static"),ghost:be(1,0,null,"same"),frozen:be(1,0,null,"same"),slowed:be(1,0,null,"same"),enter:be(4,100,400,"crossfade"),exit:be(4,100,400,"crossfade"),spawn:be(3,100,300,"crossfade"),poof:be(3,100,300,"crossfade"),celebrate:be(3,400,1200,"icon"),parcel:be(1,0,null,"icon")});var xt=300,Na=800,Va=5e3,$o=4,Wo=3e3,Tt=Object.freeze([.5,1,2,4,8]);function Yo(t){return t.kind==="conflict"&&t.source==="hold"&&t.holdId!==null}function Dt(t){return Na/t}function Xo(t){return t*xt>Va}var bn=1e4;function Jo(t){let e=0;for(let o of t.pets.values())o.live&&e++;let n=t.beat.filter(o=>o.kind==="conflict"&&!Yo(o)).length;return{people:t.characters.size,sessions:e,open:t.requests.size,conflicts:t.bangs.size+n}}var Pt=class{constructor(e){this.minGapMs=e}last=null;held=null;offer(e,n){return this.ready(n)?this.announce(e,n):(this.held=e,null)}flush(e){return this.held!==null&&this.ready(e)?this.announce(this.held,e):null}ready(e){return this.last===null||e-this.last>=this.minGapMs}announce(e,n){return this.last=n,this.held=null,e}},ct=Object.freeze(Object.assign(Object.create(null),{L:"live",l:"live",Escape:"clear_filters","+":"zoom_in","-":"zoom_out",ArrowLeft:"step_back",ArrowRight:"step_fwd",PageUp:"page_back",PageDown:"page_fwd",Enter:"select"})),Ua=t=>t!==null&&qo.has(t)&&t!=="PH_OFFLINE"?t:null,Za=t=>t!==null&&Ko.has(t)?t:null;function Qo(t,e,n){let o=[],r=new Map,s=new Set;for(let a of e)r.has(a.handle)||r.set(a.handle,a.name),!(!t.characters.has(a.handle)||s.has(a.handle))&&(s.add(a.handle),o.push({handle:a.handle,person:a.handle,name:a.name,ph:Ua(a.ph),place:At(t,{peer:a.handle},n)}));for(let[a,l]of t.pets)l.live&&o.push({handle:a,person:l.owner,name:r.get(l.owner)??l.owner,ph:Za(l.ssCode),place:At(t,{seat:a},n)});return o}var Fa="\\0",er="\\uFEFF";function tr(t){let e="",n=!1,o=!0,r=!1,s=[],a="",l=null,c=()=>{s.length>0&&t({id:l,event:a===""?"message":a,data:s.join(`\n`)}),s=[],a="",l=null},f=d=>{if(d==="")return c();if(d.startsWith(":"))return;let h=d.indexOf(":"),w=h<0?d:d.slice(0,h),A=h<0?"":d.slice(h+1);A.startsWith(" ")&&(A=A.slice(1)),w==="data"?s.push(A):w==="event"?a=A:w==="id"&&!A.includes(Fa)&&(l=A)};return{push(d){if(r||d==="")return;let h=d;o&&(o=!1,h.startsWith(er)&&(h=h.slice(er.length))),n&&h.startsWith(`\n`)&&(h=h.slice(1)),n=!1,e+=h;let w=0;for(let A=0;A<e.length;A++){let S=e[A];S!==`\n`&&S!=="\\r"||(f(e.slice(w,A)),S==="\\r"&&(A+1===e.length?n=!0:e[A+1]===`\n`&&A++),w=A+1)}e=e.slice(w)},end(){r=!0,e="",s=[]}}}var Ba=1e3,nr=3e4,za=3e4,or=/^[0-9a-f]{64}$/,Ha=/^(0|[1-9][0-9]{0,15})$/,ja=new Set(["timeline","room_snapshot","layout","overlay","room","reset","bye"]),Ga=new Set(["reset","bye"]),Je=t=>typeof t=="object"&&t!==null&&!Array.isArray(t),Nt=t=>typeof t=="number"&&Number.isSafeInteger(t)&&t>=0,qa=t=>Je(t)&&typeof t.code=="string"?t.code:null;function Ka(t){return!Je(t)||!Nt(t.cursor)||!Array.isArray(t.rooms)?!1:t.rooms.every(e=>Je(e)&&typeof e.room_id=="string"&&Je(e.layout)&&Nt(e.layout.version))}function $a(t){return!Je(t)||typeof t.type!="string"||!ja.has(t.type)?!1:Ga.has(t.type)?!0:typeof t.room_id!="string"?!1:t.type==="layout"?Je(t.layout)&&Nt(t.layout.version)&&Nt(t.layout.from_version):t.type==="room"?typeof t.change=="string":!0}function _n(t){try{t()}catch(e){queueMicrotask(()=>{throw e})}}var Vt=class{constructor(e,n){this.io=e;this.on=n}state="booting";started=!1;session=null;lastId=0;versions=new Map;gen=0;stream=null;attempt="fresh";cancelTimer=null;cancelStable=null;async start(e){if(!this.started){if(this.started=!0,e!==null){let n=++this.gen,o=null;try{o=await this.io.request({r:"session"},{method:"POST",headers:{"X-Cowork-Launch":e}})}catch{o=null}if(n!==this.gen||this.terminal())return;if(o===null)return this.finish("stopped");if(o.status===401){let s=qa(o.json);return this.finish(s==="UI_VIZ_LINK_REUSED"?"link_reused":s==="UI_VIZ_LINK_EXPIRED"?"link_expired":"need_link")}if(o.status!==200)return this.finish("stopped");let r=Je(o.json)?o.json.session:void 0;if(typeof r!="string"||!or.test(r))return this.finish("need_link");this.session=r,this.io.storage.set({session:r})}else{let n=this.io.storage.get().session;if(n===null||!or.test(n))return this.finish("need_link");this.session=n}await this.loadWorld(!1)}}stop(){this.finish("stopped")}terminal(){return this.state==="stopped"||this.state==="link_reused"||this.state==="link_expired"||this.state==="need_link"}setState(e){e!==this.state&&(this.state=e,_n(()=>this.on.state(e)))}finish(e){this.terminal()||(this.abandonStream(),this.clearTimer(),(e==="stopped"||e==="link_reused")&&this.io.storage.clear(),this.setState(e))}abandonStream(){this.gen++,this.clearStable();let e=this.stream;this.stream=null,e?.cancel()}clearTimer(){let e=this.cancelTimer;this.cancelTimer=null,e?.()}clearStable(){let e=this.cancelStable;this.cancelStable=null,e?.()}worked(){this.attempt="fresh",this.clearStable()}schedule(e,n){this.clearTimer(),this.cancelTimer=this.io.timer(e,()=>{this.cancelTimer=null,n()})}async loadWorld(e){let n=++this.gen,o=null;try{o=await this.io.request({r:"world"},{method:"GET",headers:{"X-Cowork-Session":this.session}})}catch{o=null}if(n!==this.gen||this.terminal())return;if(o===null||o.status!==200||!Ka(o.json))return this.finish(o?.status===401?"need_link":"stopped");let r=o.json;this.versions=new Map(r.rooms.map(a=>[a.room_id,a.layout.version])),this.lastId=r.cursor,_n(()=>this.on.world(r));let s=e?"last":"fresh";await this.openStream(s)==="failed"&&this.failed(s)}async openStream(e){let n=++this.gen,o=null;try{o=await this.io.stream({"X-Cowork-Session":this.session,"Last-Event-ID":String(this.lastId)})}catch{o=null}return n!==this.gen||this.terminal()?(o?.cancel(),"gone"):o===null||o.status!==200?(o?.cancel(),"failed"):(this.stream=o,this.attempt=e,this.cancelStable=this.io.timer(za,()=>{this.cancelStable=null,n===this.gen&&this.worked()}),this.setState("live"),this.pump(n,o),"live")}async pump(e,n){let o=tr(r=>{e===this.gen&&this.dispatch(r)});for(;;){let r;try{r=await n.read()}catch{r=null}if(e!==this.gen)return;if(r===null)break;if(o.push(r),e!==this.gen)return}o.end(),this.broken()}dispatch(e){let n=e.id!==null&&Ha.test(e.id)?Number(e.id):null,o;try{o=JSON.parse(e.data)}catch{o=void 0}if(n===null||!Number.isSafeInteger(n)||!$a(o)||o.type!==e.event)return this.broken();switch(this.worked(),o.type){case"bye":return this.finish("stopped");case"reset":return this.reload();case"room":if(o.change==="added")return this.reload();break;case"layout":{let r=this.versions.get(o.room_id);if(r===void 0)return this.reload();if(o.layout.version>r){if(o.layout.from_version!==r)return this.reload();this.versions.set(o.room_id,o.layout.version)}break}default:break}this.lastId=n,_n(()=>this.on.payload(o,n))}reload(){this.abandonStream(),this.loadWorld(!1)}broken(){if(this.terminal())return;let e=this.attempt;this.abandonStream(),this.failed(e)}failed(e){if(this.terminal())return;if(e==="last")return this.finish("stopped");if(this.setState("reconnecting"),e!=="fresh"&&e>=nr)return void this.loadWorld(!0);let n=e==="fresh"?Ba:Math.min(e*2,nr);this.schedule(n,()=>void this.retry(n))}async retry(e){await this.openStream(e)==="failed"&&this.failed(e)}};function rr(t,e){return e!==null&&t.rooms.some(n=>n.room_id===e)?e:t.rooms[0]?.room_id??null}var Wa=/^#k=([0-9a-f]{64})$/;function Ya(t){let e=Wa.exec(t);return e===null?null:e[1]}function sr(t){let e=t.hash;return e.startsWith("#k=")?(t.clear(),Ya(e)):null}var ar=Object.freeze(Object.assign(Object.create(null),{UI_VIZ_CARD_REQUEST:"conversation",UI_VIZ_CARD_ANSWER:"conversation",UI_VIZ_CARD_NOTE:"conversation",UI_VIZ_CARD_JOIN:"conversation",UI_VIZ_CARD_REJOIN:"conversation",UI_VIZ_CARD_LEAVE:"conversation",UI_VIZ_CARD_SEAT_START:"conversation",UI_VIZ_CARD_SEAT_END:"conversation",UI_VIZ_CARD_ABSENT:"conversation",UI_VIZ_CARD_K4:"conflict",UI_VIZ_CARD_CONFLICT:"conflict",UI_VIZ_CARD_BREACH:"conflict",UI_VIZ_CARD_PUBLISH:"activity",UI_VIZ_CARD_ROOM_OPEN:"system",UI_VIZ_CARD_VERSION:"system",UI_VIZ_CARD_RULES:"system",UI_VIZ_CARD_HEALTH:"system",UI_VIZ_CARD_FREEZE:"system",UI_VIZ_CARD_THAW:"system",UI_VIZ_CARD_SLOWED:"system",UI_VIZ_CARD_NONRETRYABLE:"system",UI_VIZ_CARD_SAVE:"system",UI_VIZ_CARD_BASE_MOVE:"system",UI_VIZ_CARD_BOARD_FULL:"system"}));var Ut=2e3,Xa=5,Ja="UI_VIZ_CARD_PUBLISH",ir="UI_VIZ_CARD_REQUEST",Qa="UI_VIZ_CARD_ANSWER",ei=6e4,An=(t,e)=>t[0]-e[0]||t[1]-e[1]||t[2]-e[2],ti=(t,e)=>t!==null&&e!==null&&("peer"in t?"peer"in e&&t.peer===e.peer:"seat"in e&&t.seat===e.seat),lr=(t,e)=>t!==null&&"peer"in t&&t.peer===e,Zt=class{cards=[];byId=new Map;statuses=new Map;add(e,n){let o=!1;for(let r of e){if(this.byId.has(r.id))continue;let s={card:r,receivedAt:n};this.byId.set(r.id,s),this.cards.push(s),o=!0}if(o&&(this.cards.sort((r,s)=>An(r.card.at,s.card.at)),this.cards.length>Ut)){for(let r of this.cards.slice(0,this.cards.length-Ut))this.byId.delete(r.card.id);this.cards=this.cards.slice(this.cards.length-Ut)}}status(e){if(e.kind!=="request_status")return;let n=this.statuses.get(e.request);if(!(n!==void 0&&An(e.at,n.at)<0)&&(this.statuses.set(e.request,{at:[e.at[0],e.at[1],e.at[2]],status:e.status}),this.statuses.size>Ut)){let o=null;for(let[r,s]of this.statuses)(o===null||An(s.at,o[1])<0)&&(o=[r,s.at]);this.statuses.delete(o[0])}}rows(e){let n=[],o=new Map;for(let{card:r}of this.cards){if(!ni(r,e))continue;if(r.code===Qa&&r.parent!==null){let l=o.get(r.parent);if(l!==void 0){l.answers.push(r);continue}}if(r.code===Ja&&r.actor!==null){let l=n[n.length-1];l!==void 0&&l.kind==="merged"&&ti(l.actor,r.actor)?l.cards.push(r):n.push({kind:"merged",actor:r.actor,cards:[r],chips:[],more:0});continue}let s=r.code===ir&&r.displayId!==null?this.statuses.get(r.displayId):void 0,a={kind:"card",card:r,answers:[],chips:s===void 0?[]:[s.status]};r.code===ir&&r.displayId!==null&&!o.has(r.displayId)&&o.set(r.displayId,a),n.push(a)}for(let r of n){if(r.kind!=="merged")continue;let s=new Set,a=0;for(let l of r.cards){for(let c of l.paths)s.add(c);a+=Math.max(0,l.n-l.paths.length)}r.chips=[...s].slice(0,Xa),r.more=s.size+a-r.chips.length}return n}at(e){let n=0,o=this.cards.length;for(;n<o;){let s=n+o>>>1;this.cards[s].card.at[0]<e?n=s+1:o=s}let r=[];for(let s=n;s<this.cards.length&&this.cards[s].card.at[0]===e;s++)r.push(this.cards[s].card);return r}key(e,n,o){let r=s=>{let a=this.seenLabel(s,n,o);return a.kind==="seen_ago"?`${s.id}~${a.n}`:`${s.id}~${a.kind}`};return JSON.stringify(e.map(s=>s.kind==="card"?[r(s.card),s.chips,s.answers.map(r)]:[s.cards.map(r),s.chips,s.more]))}seenLabel(e,n,o){let r=e.at[0];if(o)return{kind:"height",height:r};let s=this.byId.get(e.id),a=s===void 0?e.seen_ms:s.card.seen_ms;if(a===null)return{kind:"before_open",height:r};let l=s===void 0?0:n-s.receivedAt;return{kind:"seen_ago",n:Math.max(0,Math.floor((a+l)/ei))}}};function ni(t,e){return(t.group==="system"?!e.system:!e.groups.has(t.group))||e.peer!==null&&!lr(t.actor,e.peer)&&!lr(t.target,e.peer)?!1:e.desk===null||t.desks.includes(e.desk)}function Ft(t,e){if(ar[t.code]===void 0)return{code:"UI_INTERNAL_ERROR",params:{},quoted:null};let n={n:t.n};return t.actor!==null&&(n.name=e(t.actor)),t.target!==null&&(n.target=e(t.target)),t.paths.length>0&&(n.path=t.paths[0]),t.displayId!==null&&(n.id=t.displayId),{code:t.code,params:n,quoted:t.text}}function cr(t,e,n,o){let r=o.down||o.noBoard||o.gone,s=new Map;n.forEach((c,f)=>{s.has(c)||s.set(c,f)});let a=[...t.characters.entries()].map(([c,f],d)=>({actor:c,c:f,i:d,r:s.get(c)??Number.POSITIVE_INFINITY}));a.sort((c,f)=>Number(c.c.ghost)-Number(f.c.ghost)||c.r-f.r||c.i-f.i);let l=a.slice(0,16).map(({actor:c,c:f})=>({actor:c,hue:r||f.ghost?null:e.get(c)?.hue??null,hollow:f.absent}));return{grey:r,dots:l}}function Bt(t){return t===null?null:{state:t.state,unreadable:t.unreadable,down:t.down}}function ur(t,e){return t===null||e?null:{you:t.you,parcels:t.holds,cart:t.incoming,boxes:t.ready}}var yn=64,dr=Number.MAX_SAFE_INTEGER;function yt(t,e){let n=0,o=t.length;for(;n<o;){let r=n+o>>>1;t[r].height>e?o=r:n=r+1}return n}var wt=class{constructor(e){this.view=e}cache=new Map;sceneAt(e){let n=this.view(),o=n.segments;if(o.length===0)return mn(n,e);let r=0;for(let d=0;d<o.length;d++)o[d].hs<e.height&&(r=d);let s=o[r],a=r+1<o.length?o[r+1].hs:Number.POSITIVE_INFINITY,l=n.events.length===0?Number.NEGATIVE_INFINITY:n.events[n.events.length-1].height,c=s.hs+yn*Math.floor((Math.min(e.height,l)-1-s.hs)/yn);if(!(c>s.hs))return this.reduceFrom(n,s.start,r===0?0:yt(n.events,s.hs),a,e);let f=this.entry(n,r,c);return this.reduceFrom(n,f,yt(n.events,c),a,e)}holds(e){let n=this.view();if(n.segments.length===0)return!1;let o=Math.max(n.segments[n.segments.length-1].hs,n.events.length===0?Number.NEGATIVE_INFINITY:n.events[n.events.length-1].height);return e>=n.segments[0].hs&&e<=o}invalidate(e){for(let[n,o]of this.cache)(n>=e||o.hs>=e)&&this.cache.delete(n)}entry(e,n,o){let r=e.segments[n],s=this.cache.get(o);if(s!==void 0&&s.hs===r.hs&&s.start===r.start)return s.scene;let a=o-yn,l={height:o,sub:dr,k:dr},c=a>r.hs?this.reduceFrom(e,this.entry(e,n,a),yt(e.events,a),o,l):this.reduceFrom(e,r.start,n===0?0:yt(e.events,r.hs),o,l);return this.cache.set(o,{hs:r.hs,start:r.start,scene:c}),c}reduceFrom(e,n,o,r,s){let a=e.events.slice(o,yt(e.events,Math.min(r,s.height)));return mn({segments:[{hs:n.at.height,start:n}],events:a,layout:e.layout},s)}};function fr(t,e,n){let o=new Set,r=new Set;for(let s of t.desks)Ho(e,s.ordinal)&&o.add(s.ordinal),s.lockbox&&r.add(s.ordinal);return{dashedFrom:n.live?null:e.at.height,dimmed:o,coarse:n.coarse,lockboxDesks:r}}var hr=256,pr=Number.MAX_SAFE_INTEGER,mr=t=>`${t.height}.${t.sub}.${t.k}`,zt=class{constructor(e,n,o,r,s){this.io=s;this.id=e,this.h0=o.h0,this.h1=o.h1,this.layoutNow=r,this.segments=[{hs:o.h1,start:n}],this.seekCache=new wt(()=>this.view()),this.headReducer=new Xe(n,()=>this.layoutNow)}id;h0;h1;layoutNow;segments;events=[];seekCache;headReducer;busy=!1;target=null;earlierWanted=!1;epoch=0;draining=Promise.resolve();get layout(){return this.layoutNow}setLayout(e){this.layoutNow=e}view(){return{segments:this.segments,events:this.events,layout:this.layoutNow}}head(){return this.headReducer.scene()}append(e,n){let o=[];for(let r of e){let s=this.events[this.events.length-1];if(!(s!==void 0&&Me(r,s)<=0)){try{this.headReducer.push(r)}catch{continue}this.events.push(r),o.push(r)}}return this.h1=Math.max(this.h1,n),o}snapshot(e,n){this.epoch++,this.h0=Math.min(this.h0,n.h0),this.h1=n.h1,this.segments=[{hs:n.h1,start:e}],this.events=[],this.seekCache=new wt(()=>this.view()),this.headReducer=new Xe(e,()=>this.layoutNow)}top(){return Math.max(this.h1,this.events.length===0?Number.NEGATIVE_INFINITY:this.events[this.events.length-1].height)}holds(e){return Number.isSafeInteger(e)&&e>=this.segments[0].hs&&e<=this.top()}sceneAt(e){return this.holds(e)?this.seekCache.sceneAt({height:e,sub:pr,k:pr}):null}nextHeight(e){let n=this.events,o=0,r=n.length;for(;o<r;){let s=o+r>>>1;n[s].height>e?r=s:o=s+1}return o<n.length?n[o].height:null}loading(){return this.busy}canEarlier(){return this.h0>0&&!this.busy}want(e){return this.target=e,this.pump()}dropTarget(){this.target=null}earlier(){return this.h0>0&&(this.earlierWanted=!0),this.pump()}pump(){return this.busy||(this.draining=this.drain()),this.draining}async drain(){this.busy=!0,this.io.changed();try{for(let e=this.plan();e!==null;e=this.plan()){let n=this.epoch,o=await this.range(e,n);if(n===this.epoch){if(o===null){this.target=null,this.earlierWanted=!1;break}this.merge(o),e.earlier&&(this.earlierWanted=!1),this.io.changed()}}}finally{this.busy=!1,this.io.changed()}}plan(){let e=this.segments[0].hs,n=gr(this.h0)-1,o=r=>e>r?{from:Math.max(n+1,e-(hr-1)),to:e,earlier:!1}:null;if(this.target!==null){let r=o(Math.max(this.target,n));if(r!==null)return r;this.target=null}return this.earlierWanted?this.h0<=0?(this.earlierWanted=!1,null):o(n)??{from:gr(Math.max(0,this.h0-hr)),to:this.h0,earlier:!0}:null}async range(e,n){let o=[];for(let r=e.from;r<=e.to;){let s;try{s=await this.io.page(r,e.to)}catch{return null}if(n!==this.epoch||s===null||s.room!==this.id||s.from!==r||!Number.isSafeInteger(s.to)||s.to<r||s.to>e.to)return null;let a=s.from,l=s.to;if(!s.events.every(c=>c.height>=a&&c.height<=l))return null;o.push(s),r=s.to+1}return o}merge(e){this.io.merged(e);for(let r of e)this.segments.push({hs:r.from-1,start:r.start});this.segments.sort((r,s)=>r.hs-s.hs);let n=new Set(this.events.map(mr)),o=e.flatMap(r=>r.events).filter(r=>!n.has(mr(r)));o.length>0&&(this.events=[...o,...this.events].sort(Me)),this.h0=Math.min(this.h0,Math.max(0,e[0].from-1))}};function gr(t){return t===0?0:t+1}var Ht=class{constructor(e,n){this.layout=n;this.shown=new Xe(e,n)}shown;queue=[];reset(e){this.shown=new Xe(e,this.layout),this.queue=[]}push(e){this.queue.push(...e)}queued(){return this.queue.length}scene(){return this.shown.scene()}beat(e){if(this.queue.length===0)return null;let n=new Set(this.queue.map(s=>s.height));if(Xo(n.size)){let s=this.queue[this.queue.length-1].height;return this.reset(e()),{kind:"snap",height:s,scene:this.scene()}}let o=this.queue[0].height,r=this.queue.filter(s=>s.height===o);this.queue=this.queue.filter(s=>s.height!==o);for(let s of r)try{this.shown.push(s)}catch{}return{kind:"beat",height:o,events:r,scene:this.scene()}}};var wn=Object.freeze({UI_VIZ_STOPPED:Object.freeze({text:"The viewer stopped. Run /cowork view to open it again."}),UI_VIZ_LINK_EXPIRED:Object.freeze({text:"This link has expired. Run /cowork view again."}),UI_VIZ_LINK_REUSED:Object.freeze({text:"This link was opened twice, so the viewer stopped. If you did not open it twice, another program or user on this PC may have opened it. Run /cowork view again."}),UI_VIZ_NEED_LINK:Object.freeze({text:"Open the viewer with the link that /cowork view gives you."})}),br=t=>typeof t=="object"&&t!==null&&!Array.isArray(t),jt=class{served={};answered=new Set;merged={en:wn};asked(e){return this.answered.has(e)}accept(e,n){if(!br(n)||!br(n.templates))return!1;let o=Ue.find(r=>r===n.lang);return o===void 0?!1:(this.served[o]=n.templates,this.answered.add(e),this.answered.add(o),this.merged={...this.served,en:{...wn,...this.served.en}},!0)}has(e){return this.served[e]!==void 0||this.served.en!==void 0}can(e,n){return this.has(n)||Object.hasOwn(wn,e)}render(e,n,o){return ko(this.merged,gn,e,n,"viz",o)}};var kn=t=>({height:t[0],sub:t[1],k:t[2]}),_r=t=>t===null?null:kn(t),je=t=>"peer"in t?{peer:t.peer}:{seat:t.seat};function oi(t){switch(t.at){case"home":return{at:"home",spot:t.spot};case"chair":case"stool":case"beside":return{at:t.at,desk:t.desk};case"visitor":return{at:"visitor",desk:t.desk,tile:t.tile};case"facing":return{at:"facing",actor:je(t.actor),desk:t.desk};case"behind":return{at:"behind",peer:t.peer}}}function Ar(t){return{place:oi(t.place),pose:t.pose,lastPublish:_r(t.lastPublish),lastDesk:t.lastDesk,lastClaimOp:_r(t.lastClaimOp)}}function Gt(t){let{at:e,...n}=t;return{height:e[0],sub:e[1],k:e[2],...structuredClone(n)}}function qt(t){let e=new Map;for(let[c,f]of t.characters)e.set(c,{...Ar(f),ghost:f.ghost,absent:f.absent,frozen:f.frozen,slowedUntil:f.slowedUntil,rules:f.rules,credit:f.credit});let n=new Map;for(let[c,f]of t.pets)n.set(c,{...Ar(f),owner:f.owner,variant:f.variant,live:f.live,ssCode:f.ssCode});let o=new Map;for(let[c,f]of t.desks)o.set(c,{lastEvent:f.lastEvent,chair:f.chair===null?null:je(f.chair),visitors:f.visitors.map(je),more:f.more,claims:[...f.claims]});let r=new Map;for(let[c,f]of t.claims){let d=f;r.set(c,{seat:d.seat,desk:d.desk,order:d.order,label:d.label===null?null:{simple:d.label.simple,qualname:d.label.qualname},granularity:d.granularity,lines:d.lines===null?null:[d.lines[0],d.lines[1]],stale:d.stale,reservedFor:d.reservedFor,grantee:d.grantee===null?null:je(d.grantee),otherRules:d.otherRules,at:kn(d.at??t.at)})}let s=new Map;for(let[c,f]of t.requests)s.set(c,{from:je(f.from),holder:je(f.holder),desk:f.desk,status:f.status});let a=new Map;for(let[c,f]of t.boxes)a.set(c,{owner:je(f.owner),desk:f.desk,holdKind:f.holdKind,residence:f.residence,state:f.state,localOnly:f.localOnly});let l=new Map;for(let[c,f]of t.bangs)l.set(c,{on:je(f.on),desk:f.desk});return{at:kn(t.at),badge:t.badge,branchMovedAt:t.branchMovedAt,characters:e,pets:n,desks:o,claims:r,requests:s,boxes:a,bangs:l,beat:t.beat.map(Gt)}}function ri(t,e){let n=t.kind==="big_table"?fn:t.kind==="file"?t.path??`#${t.ordinal}`:t.kind==="folder"?`${t.plaque??`#${t.ordinal}`}/`:`${(t.zone===null?void 0:e[t.zone]?.key)??`#${t.ordinal}`}/${Ro}`;return Object.freeze({ordinal:t.ordinal,key:n,kind:t.kind,zone:t.zone,cell:t.cell,slot:t.slot,path:t.path,lockbox:t.lockbox,first:t.first})}function In(t){let e=t.zones.map(r=>({index:r.index,key:r.sign,cells:[...r.cells]})),n=t.desks.map(r=>ri(r,e)),o=new Map;for(let r of n)r.kind==="file"&&r.path!==null&&o.set(r.path,r.ordinal);return{version:t.version,zones:e,desks:n,homeOrder:[...t.homeOrder],deskOf:o}}function En(t,e){if(e.version<=t.version)return t;if(e.from_version!==t.version)return"reload";let n=t.zones.map(a=>({index:a.index,sign:a.sign,cells:[...a.cells]}));for(let a of e.zones){let l={index:a.index,sign:a.sign,cells:[...a.cells]};if(a.index<n.length&&n[a.index].sign===a.sign)n[a.index]=l;else if(a.index===n.length)n.push(l);else return"reload"}let o=[...t.desks];for(let a of e.desks){if(a.ordinal!==o.length)return"reload";o.push({...a})}let r=new Set(t.homeOrder),s=[...t.homeOrder];for(let a of e.homeOrder)r.has(a)||(r.add(a),s.push(a));return{version:e.version,zones:n,desks:o,homeOrder:s}}var k=Object.freeze({app:"app",top:"top",banner:"banner",status:"status",notice:"notice",lamp:"lamp",lampOk:"lamp-ok",lampWarn:"lamp-warn",lampDown:"lamp-down",main:"main",map:"map",rooms:"rooms",room:"room",office:"office",scroll:"scroll",caption:"caption",pixel:"pixel",log:"log",filters:"filters",filter:"filter",cards:"cards",card:"card",cardSystem:"card-system",head:"head",swatch:"swatch",name:"name",text:"text",quote:"quote",chips:"chips",chip:"chip",meta:"meta",answers:"answers",newPill:"new-pill",rewind:"rewind",track:"track",ticks:"ticks",slider:"slider",position:"position",control:"control",livePill:"live-pill",liveOn:"live-on",liveOff:"live-off",controls:"controls",srOnly:"sr-only",people:"people",person:"person",hue0:"hue-0",hue1:"hue-1",hue2:"hue-2",hue3:"hue-3",hue4:"hue-4",hue5:"hue-5",hue6:"hue-6"}),Sn=Object.freeze([k.hue0,k.hue1,k.hue2,k.hue3,k.hue4,k.hue5,k.hue6]);function B(t,e,n){let o=document.createElement(t);return e!==null&&(o.className=e),n!==void 0&&n.append(o),o}function _e(t,e,n){let o=B("button",t,e);return o.type="button",o.addEventListener("click",()=>n()),o}function xe(t,e){t.setAttribute("aria-pressed",String(e))}function Rn(t,e){return e===null?null:e.code==="UI_VIZ_HOLDING"?t(e.code,{label:e.label??"?"}):t(e.code,{path:e.path??"?",height:e.height})}var si="(prefers-reduced-motion: reduce)";function yr(t){let{root:e,canvas:n,people:o,live:r,t:s}=t;n.setAttribute("role","img"),r.setAttribute("aria-live","polite"),r.setAttribute("role","status");let a=window.matchMedia(si),l=null,c=!1,f=new Pt(bn),d=null,h={s:null,characters:[],layout:null},w="",A=new Map,S=()=>l??a.matches,g=_e(k.control,t.controls,()=>{l=!S(),p(!0)}),R=_e(k.control,t.controls,()=>{c=!c,xe(R,c),t.onMotion()});xe(R,!1);let p=C=>{let X=S();X?e.setAttribute("data-motion","reduced"):e.removeAttribute("data-motion"),xe(g,X),C&&t.onMotion()};a.addEventListener("change",()=>p(!0));let E=()=>{g.textContent=s("UI_VIZ_CTRL_REDUCED_MOTION"),R.textContent=s(c?"UI_VIZ_CTRL_PLAY":"UI_VIZ_CTRL_PAUSE"),w="",V()},V=()=>{let{s:C,characters:X,layout:z}=h;if(R.textContent=s(c?"UI_VIZ_CTRL_PLAY":"UI_VIZ_CTRL_PAUSE"),C===null||z===null){n.removeAttribute("aria-label"),o.replaceChildren(),w="",A.clear();return}let H=Jo(C);n.setAttribute("aria-label",s("UI_VIZ_SCENE_SUMMARY",{people:H.people,sessions:H.sessions,open:H.open,conflicts:H.conflicts}));let Q=Qo(C,X,z).map(re=>{let D=[re.name];re.ph!==null&&D.push(s(re.ph,{reason:C.characters.get(re.handle)?.frozen??"?"}));let $=Rn(s,re.place);return $!==null&&D.push($),{handle:re.handle,person:re.person,text:D.join(" · ")}}),oe=JSON.stringify(Q);if(oe===w)return;w=oe;let Ie=[...A].find(([,re])=>re===document.activeElement)?.[0]??null;A.clear(),o.replaceChildren(...Q.map(re=>{let D=B("li",null),$=_e(k.person,D,()=>t.onPerson(re.person));return $.textContent=re.text,A.set(re.handle,$),D})),Ie!==null&&A.get(Ie)?.focus({preventScroll:!0})};return p(!1),{reduced:S,paused:()=>c,scene(C,X,z){h={s:C,characters:X,layout:z},V()},announce(C){let X=performance.now(),z=f.offer(C,X);z!==null?r.textContent=z:d===null&&(d=window.setTimeout(()=>{d=null;let H=f.flush(performance.now());H!==null&&(r.textContent=H)},bn))},relabel:E}}var ai=/^r[0-9A-HJKMNP-TV-Z]{8}$/,ii=/^(0|[1-9][0-9]{0,9})$/,vn="X-Cowork-Session";function wr(t){if(typeof t!="number"||!Number.isSafeInteger(t))return null;let e=String(t);return ii.test(e)?e:null}function li(t,e){switch(t.r){case"session":return fetch("/api/v1/session",{method:e.method,headers:e.headers,credentials:"omit",cache:"no-store",redirect:"error"});case"world":return fetch("/api/v1/world",{method:e.method,headers:e.headers,credentials:"omit",cache:"no-store",redirect:"error"});case"strings":{let n=t.lang;return typeof n!="string"||!Ue.includes(n)?Promise.reject(new TypeError):fetch(`/api/v1/strings?lang=${n}`,{method:e.method,headers:e.headers,credentials:"omit",cache:"no-store",redirect:"error"})}case"timeline":{let n=t.room,o=wr(t.from),r=wr(t.to);return typeof n!="string"||!ai.test(n)||o===null||r===null?Promise.reject(new TypeError):fetch(`/api/v1/rooms/${n}/timeline?from=${o}&to=${r}`,{method:e.method,headers:e.headers,credentials:"omit",cache:"no-store",redirect:"error"})}default:return Promise.reject(new TypeError)}}function kr(){try{let t=sessionStorage.getItem(vn);if(t===null)return null;let e=JSON.parse(t);if(typeof e!="object"||e===null)return null;let n=e;return{session:typeof n.session=="string"?n.session:null,room:typeof n.room=="string"?n.room:null}}catch{return null}}function Ir(){let t={session:null,room:null};return{async request(e,n){let o=await li(e,n),r=null;try{r=await o.json()}catch{r=null}return{status:o.status,json:r}},async stream(e){let n=await fetch("/api/v1/stream",{method:"GET",headers:e,credentials:"omit",cache:"no-store",redirect:"error"}),o=n.body;if(o===null)return{status:n.status,read:()=>Promise.resolve(null),cancel:()=>{}};let r=o.getReader(),s=new TextDecoder,a=!1;return{status:n.status,async read(){if(a)return null;let l=await r.read();if(l.done){a=!0;let c=s.decode();return c===""?null:c}return s.decode(l.value,{stream:!0})},cancel(){a=!0,r.cancel().catch(()=>{})}}},timer(e,n){let o=setTimeout(()=>n(),e);return()=>clearTimeout(o)},storage:{get(){let e=kr();return e===null?{...t}:{session:e.session??t.session,room:e.room??t.room}},set(e){let n=kr()??t;t={session:e.session??n.session??t.session,room:e.room??n.room??t.room};try{sessionStorage.setItem(vn,JSON.stringify(t))}catch{}},clear(){t={session:null,room:null};try{sessionStorage.removeItem(vn)}catch{}}}}}var ci=Object.freeze(Object.assign(Object.create(null),{asked:"UI_VIZ_ICON_ASKED",queued_until_turn_end:"UI_VIZ_ICON_QUEUED",awaiting_human:"UI_VIZ_ICON_AWAITING_HUMAN",undeliverable:"UI_VIZ_ICON_UNDELIVERABLE",returned:"UI_VIZ_CHIP_ASKED_AGAIN"})),ui=Object.freeze([{group:"conversation",code:"UI_VIZ_FILTER_CONVERSATION"},{group:"activity",code:"UI_VIZ_FILTER_ACTIVITY"},{group:"conflict",code:"UI_VIZ_FILTER_CONFLICTS"},{group:"system",code:"UI_VIZ_FILTER_SYSTEM"}]),di=4;function Er(t,e){let{t:n}=e,o=B("div",k.filters,t),r=B("ul",k.cards,t),s=_e(k.newPill,t,()=>{r.scrollTop=r.scrollHeight,s.hidden=!0});s.hidden=!0,r.addEventListener("scroll",()=>{p()&&(s.hidden=!0)});let a=new Set(["conversation","activity","conflict"]),l=!1,c=null,f=null,d=new Set,h={model:null,replay:!1,nowMono:0},w=null,A=_e(k.filter,o,()=>{E(),e.changed()}),S=ui.map(D=>{let $=_e(k.filter,o,()=>{D.group==="system"?l=!l:a.has(D.group)?a.delete(D.group):a.add(D.group),e.changed()});return{k:D,b:$}}),g=_e(k.filter,o,()=>{c=null,e.changed()}),R=_e(k.filter,o,()=>{f=null,e.changed()}),p=()=>r.scrollTop+r.clientHeight>=r.scrollHeight-di,E=()=>{a.clear(),a.add("conversation"),a.add("activity"),a.add("conflict"),l=!1,c=null,f=null},V=()=>{A.textContent=n("UI_VIZ_FILTER_ALL"),xe(A,c===null&&f===null&&a.size===3);for(let{k:$,b:G}of S)G.textContent=n($.code),xe(G,$.group==="system"?l:a.has($.group));g.hidden=c===null,g.textContent=c===null?"":`${n("UI_VIZ_FILTER_PERSON")}: ${e.nameOf({peer:c})} ×`,xe(g,c!==null);let D=f===null?null:e.pathOfDesk(f);R.hidden=f===null,R.textContent=f===null?"":`${n("UI_VIZ_FILTER_FILE")}: ${D??`#${f}`} ×`,xe(R,f!==null)},C=new Map,X=(D,$,G,ee)=>{let te=B("div",k.head,D);if($!==null){let fe=e.hueOf($),U=B("span",k.swatch,te);fe!==null&&fe>=0&&fe<Sn.length&&U.classList.add(Sn[fe]);let J=e.personOf($),ue=_e(k.name,te,()=>{J!==null&&(c=J,e.changed())});ue.textContent=e.nameOf($),C.set(`${ee}|`,ue)}G!==null&&(B("span",k.meta,te).textContent=G)},z=(D,$,G,ee)=>{if($.length===0&&G<=0)return;let te=B("div",k.chips,D);for(let fe of $){let U=_e(k.chip,te,()=>{let J=e.deskOfPath(fe);J!==null&&(f=J,e.changed())});U.textContent=fe,C.set(`${ee}|${fe}`,U)}G>0&&(B("span",k.chip,te).textContent=n("UI_VIZ_MORE",{n:G}))},H=(D,$)=>{let G=h.model;if(G===null)return;let ee=G.seenLabel($,h.nowMono,h.replay),te=B("div",k.meta,D);switch(ee.kind){case"seen_ago":te.textContent=n("UI_VIZ_SEEN_AGO",{n:ee.n});break;case"before_open":te.textContent=`#${ee.height} · ${n("UI_VIZ_SEEN_BEFORE_OPEN")}`;break;case"height":te.textContent=`#${ee.height}`;break}},Q=(D,$,G)=>{let ee=B("li",k.card);D.group==="system"&&ee.classList.add(k.cardSystem),D.detail!==null&&(ee.title=D.detail),X(ee,D.actor,D.displayId,D.id);let{code:te,params:fe,quoted:U}=Ft(D,e.nameOf);if(B("div",k.text,ee).textContent=n(te,fe),U!==null&&(B("blockquote",k.quote,ee).textContent=U),G.length>0){let J=B("div",k.chips,ee);for(let ue of G){let se=ci[ue];se!==void 0&&(B("span",k.chip,J).textContent=n(se))}}if(D.code!=="UI_VIZ_CARD_PUBLISH"&&z(ee,D.paths,0,D.id),H(ee,D),$.length>0){let J=B("ul",k.answers,ee);for(let ue of $)J.append(Q(ue,[],[]))}return ee},oe=D=>{let $=B("li",k.card),G=D.cards[0].id;X($,D.actor,null,G);let ee=D.cards.reduce((te,fe)=>te+fe.n,0);return B("div",k.text,$).textContent=n("UI_VIZ_CARD_PUBLISH",{name:e.nameOf(D.actor),n:ee}),z($,D.chips,D.more,G),H($,D.cards[D.cards.length-1]),$},Ie=(D,$)=>{h={model:D,replay:$.replay,nowMono:$.nowMono},V();let G=D===null?[]:D.rows(re()),ee=D===null?"":`${e.version()}|${D.key(G,$.nowMono,$.replay)}`;if(w!==null&&w.model===D&&w.key===ee)return;w={model:D,key:ee};let te=p(),fe=[...C].find(([,se])=>se===document.activeElement)?.[0]??null;C=new Map;let U=G.map(se=>se.kind==="card"?Q(se.card,se.answers,se.chips):oe(se));r.replaceChildren(...U),fe!==null&&C.get(fe)?.focus({preventScroll:!0});let J=new Set;for(let se of G)for(let Re of se.kind==="card"?[se.card,...se.answers]:se.cards)J.add(Re.id);let ue=[...J].some(se=>!d.has(se));d=J,te?r.scrollTop=r.scrollHeight:ue&&(s.hidden=!1)},re=()=>({peer:c,desk:f,groups:new Set(a),system:l});return{render:Ie,filter:re,person(D){c=D},desk(D){f=D},clear:E,relabel(){s.textContent=n("UI_VIZ_NEW_PILL"),w=null,Ie(h.model,h)}}}function ye(t){return Object.freeze([parseInt(t.slice(1,3),16),parseInt(t.slice(3,5),16),parseInt(t.slice(5,7),16)])}var vr=ye("#000000"),fi=ye("#FFFFFF"),hi=Object.freeze(["#D97757","#E69F00","#56B4E9","#009E73","#F0E442","#0072B2","#CC79A7"].map(ye)),Nc=Object.freeze(["APRICOT","AMBER","SKY","GREEN","LEMON","BLUE","PINK"]),pi=Object.freeze(["BEANIE","HEADPHONES","SUNGLASSES","SCARF","SPROUT","CAP","BOW","GLASSES"]),me=Object.freeze({cheek:ye("#F2B49A"),eyeWhite:ye("#FFFFFF"),pupil:ye("#1A1A1A"),lens:ye("#59C3FF")}),Ae=Object.freeze({floorA:ye("#3A3346"),floorB:ye("#342E40"),wall:ye("#22222C"),deskA:ye("#6B4A2E"),deskB:ye("#8A6440"),monitor:ye("#2B2B38"),screenIdle:ye("#59C3FF"),screenPublished:ye("#7FE0A0"),accent:ye("#D97757")}),N=(t,e)=>Object.freeze([ye(t),ye(e)]),mi=Object.freeze([{main:N("#3E7CB1","#2A5578"),alt:N("#6A3FA0","#4B2C6B")},{main:N("#E4E4E4","#333344"),alt:N("#5B3A8E","#D9D9D9")},{main:N("#222222","#222222"),alt:N("#F4F1E8","#F4F1E8")},{main:N("#C8463D","#8E2E28"),alt:N("#1F4F4F","#143838")},{main:N("#7BC043","#3E7A2A"),alt:N("#F7F3EA","#3E7A2A")},{main:N("#2F5D8A","#F4F1E8"),alt:N("#D9D9D9","#2D2D2D")},{main:N("#E8485F","#9E2A44"),alt:N("#F7F3EA","#9E2A44")},{main:N("#3A2C24","#3A2C24"),alt:N("#F4F1E8","#F4F1E8")}].map(t=>Object.freeze(t))),y={red:"#E04A3F",deepRed:"#9E2A2A",orange:"#F08A24",green:"#5CC86A",gold:"#F2C14E",darkGold:"#B8862E",yellow:"#F0E442",ice:"#BDEBFF",grey:"#9AA0AE",darkGrey:"#5A5F6E",light:"#D9D9D9",wood:"#A0703A",card:"#C89858",tape:"#E8D8A8",purple:"#8E6BD8",badgeBlue:"#3E7CB1",pink:"#F06EA9",cyan:"#59C3FF",white:"#FFFFFF",skin:"#F2B49A",sage:"#8FB08A",apricot:"#D97757"},Ze=Object.freeze({queued:N(y.gold,y.wood),asked:N(y.white,y.white),awaiting_human:N(y.skin,y.skin),undeliverable:N(y.grey,y.red),accepted:N(y.skin,y.green),declined:N(y.red,y.red),later:N(y.white,y.grey),daemon:N(y.grey,y.grey),wake:N(y.red,y.red),flag:N(y.green,y.wood),tick:N(y.green,y.green),star:N(y.gold,y.gold),snowflake:N(y.ice,y.ice),door:N(y.wood,y.gold),speech:N(y.white,y.white),bang:N(y.red,y.deepRed),snail:N(y.orange,y.sage),ice:N(y.ice,y.ice),paused:N(y.white,y.darkGrey),zzz:N(y.white,y.white),parcel:N(y.card,y.tape),cart:N(y.grey,y.darkGrey),lockbox:N(y.grey,y.gold),bin:N(y.grey,y.grey),lock:N(y.gold,y.grey),keyboard:N(y.light,y.darkGrey),clipboard:N(y.wood,y.white),bolt:N(y.yellow,y.gold),version:N(y.white,y.badgeBlue),rules:N(y.white,y.purple),credit:N(y.gold,y.darkGold),health:N(y.gold,y.gold),plane:N(y.white,y.grey),sparkle:N(y.white,y.gold),confetti:N(y.pink,y.cyan),stamp:N(y.red,y.red),sign:N(y.wood,y.white),cabinet:N(y.grey,y.grey),more:N(y.white,y.darkGrey),caught_up:N(y.green,y.green),you:N(y.apricot,y.white),think:N(y.white,y.white)}),Or=N(y.orange,y.orange);function ze(t,e,n){return[Math.round(t[0]+(e[0]-t[0])*n),Math.round(t[1]+(e[1]-t[1])*n),Math.round(t[2]+(e[2]-t[2])*n)]}var gi=[[.4124564,.3575761,.1804375],[.2126729,.7151522,.072175],[.0193339,.119192,.9503041]],bi=[[3.2404542,-1.5371385,-.4985314],[-.969266,1.8760108,.041556],[.0556434,-.2040259,1.0572252]],ut=[.95047,1,1.08883],Mr=216/24389,Cr=24389/27;function On(t){let e=t/255;return e<=.04045?e/12.92:Math.pow((e+.055)/1.055,2.4)}function Mn(t){let e=t<=.0031308?12.92*t:1.055*Math.pow(t,.4166666666666667)-.055;return Math.round(Math.min(1,Math.max(0,e))*255)}function Lr(t,e){return[t[0][0]*e[0]+t[0][1]*e[1]+t[0][2]*e[2],t[1][0]*e[0]+t[1][1]*e[1]+t[1][2]*e[2],t[2][0]*e[0]+t[2][1]*e[1]+t[2][2]*e[2]]}var Cn=t=>t>Mr?Math.cbrt(t):(Cr*t+16)/116,Ln=t=>{let e=t*t*t;return e>Mr?e:(116*t-16)/Cr};function Be(t){let[e,n,o]=Lr(gi,[On(t[0]),On(t[1]),On(t[2])]),r=Cn(e/ut[0]),s=Cn(n/ut[1]),a=Cn(o/ut[2]);return{L:116*s-16,a:500*(r-s),b:200*(s-a)}}function _i(t){let e=(t.L+16)/116,n=e+t.a/500,o=e-t.b/200,[r,s,a]=Lr(bi,[Ln(n)*ut[0],Ln(e)*ut[1],Ln(o)*ut[2]]);return[Mn(r),Mn(s),Mn(a)]}var Qe=Math.PI/180,Sr=(t,e)=>{if(e===0&&t===0)return 0;let n=Math.atan2(t,e)/Qe;return n<0?n+360:n};function kt(t,e){let n=Math.hypot(t.a,t.b),o=Math.hypot(e.a,e.b),r=(n+o)/2,s=Math.pow(r,7),a=.5*(1-Math.sqrt(s/(s+Math.pow(25,7)))),l=(1+a)*t.a,c=(1+a)*e.a,f=Math.hypot(l,t.b),d=Math.hypot(c,e.b),h=Sr(t.b,l),w=Sr(e.b,c),A=e.L-t.L,S=d-f,g=0;f*d!==0&&(g=w-h,g>180?g-=360:g<-180&&(g+=360));let R=2*Math.sqrt(f*d)*Math.sin(g/2*Qe),p=(t.L+e.L)/2,E=(f+d)/2,V=h+w;f*d!==0&&(Math.abs(h-w)<=180?V=(h+w)/2:V=h+w<360?(h+w+360)/2:(h+w-360)/2);let C=1-.17*Math.cos((V-30)*Qe)+.24*Math.cos(2*V*Qe)+.32*Math.cos((3*V+6)*Qe)-.2*Math.cos((4*V-63)*Qe),X=30*Math.exp(-Math.pow((V-275)/25,2)),z=Math.pow(E,7),H=2*Math.sqrt(z/(z+Math.pow(25,7))),Q=1+.015*Math.pow(p-50,2)/Math.sqrt(20+Math.pow(p-50,2)),oe=1+.045*E,Ie=1+.015*E*C,re=-Math.sin(2*X*Qe)*H;return Math.sqrt((A/Q)**2+(S/oe)**2+(R/Ie)**2+re*(S/oe)*(R/Ie))}var Ai=.35,xr=.35,yi=20,wi=15,ki=10,xn=15,Tn=55,Dn=80;function Rr(t,e){let n=Be(t),o=Be(ze(t,vr,xr));return{outline:e.every(r=>kt(o,Be(r))>=yi),eye:kt(Be(me.eyeWhite),n)>=wi,cheek:kt(Be(me.cheek),n)>=ki}}function Ii(t,e=[Ae.floorA,Ae.floorB]){let n=Rr(t,e);if(n.outline&&n.eye&&n.cheek)return t;let o=Be(t),r=n.outline?-1:1;for(let s=1;;s++){let a=o.L+r*s;if(r>0?a>Dn:a<Tn)break;if(a<Tn||a>Dn)continue;let l=_i({L:a,a:o.a,b:o.b}),c=Rr(l,e);if(c.outline&&c.eye&&c.cheek)return l}throw new RangeError(`palette: no L* in ${Tn}-${Dn} makes rgb(${t.join(", ")}) pass the scene-contrast tests`)}function Ei(){let t=hi.map(n=>Ii(n)),e=t.map(n=>{let o=Be(n),r=ze(n,fi,Ai),s=ze(n,vr,xr);return mi.map((a,l)=>{let c=a.main;if(kt(Be(a.main[0]),o)<xn){if(kt(Be(a.alt[0]),o)<xn)throw new RangeError(`palette: neither tone pair of ${pi[l]} clears ΔE ${xn} against rgb(${n.join(", ")})`);c=a.alt}return{body:n,highlight:r,outline:s,accessory:c}})});return{bodies:t,characters:e}}function Si(t){for(let e of t.characters){for(let n of e)Object.freeze(n);Object.freeze(e)}return Object.freeze(t.characters),Object.freeze(t.bodies),Object.freeze(t)}var It=Si(Ei());var P=t=>Object.freeze([...t]),ce=(t,e)=>Array.from({length:e},()=>t),He=P(["................",".....oooooo.....","...oobbbbbboo...","..obbhhbbbbbbo..","..obhhbbbbbbbo..",".obbbbbbbbbbbbo.",".obbwkbbbbwkbbo.",".obbwkbbbbwkbbo.",".obcbbbbbbbbcbo.",".obbbbbkkbbbbbo.","..obbbbbbbbbbo..","..obbbbbbbbbbo..","...oobbbbbboo...","....ofo..ofo....","....ooo..ooo....","................"]),Ge=t=>new Map(Object.entries(t).map(([e,n])=>[Number(e),n])),Tr=Object.freeze({beanie:Ge({0:"......aaaa......",1:"....aaaaaaaa....",2:"...AAAAAAAAAA..."}),headphones:Ge({1:".....AAAAAA.....",5:"aa............aa",6:"aA............Aa",7:"aA............Aa",8:"aa............aa"}),sunglasses:Ge({6:"...AllAAAAllA...",7:"....ll....ll...."}),scarf:Ge({10:"..aaaaaaaaaaaa..",11:"..........aa....",12:"..........aA...."}),sprout:Ge({0:"......aaAaa....."}),cap:Ge({1:".....AAAAAA.....",2:"...aaaaaaaaaa...",3:"..........aaaaa."}),bow:Ge({1:"..aAa...........",2:"...a............"}),glasses:Ge({5:"...AAAA..AAAA...",6:"...A..AAAA..A...",7:"...A..A..A..A...",8:"...AAAA..AAAA..."})}),Dr=P(["..oooo..",".obhhbo.","obhbbbbo","obkbbkbo","obcbbcbo","obbbbbbo",".oobboo.","..o..o.."]),Pr=Object.freeze([null,P(["aa"]),P(["A"]),P([".a.","aAa",".a."])]),Nr=Object.freeze([["www","w.w","w.w","w.w","www"],[".w.","ww.",".w.",".w.","www"],["www","..w","www","w..","www"],["www","..w",".ww","..w","www"],["w.w","w.w","www","..w","..w"],["www","w..","www","..w","www"],["www","w..","www","w.w","www"],["www","..w",".w.",".w.",".w."],["www","w.w","www","w.w","www"],["www","w.w","www","..w","www"]].map(P)),pe=Object.freeze({queued:P(["AAAAAAAA",".waaaaw.","..waaw..","...ww...","...ww...","..w..w..",".waaaaw.","AAAAAAAA"]),asked:P(["..wwww..",".ww..ww.",".....ww.","....ww..","...ww...","...ww...","........","...ww..."]),awaiting_human:P([".a.a.a..",".a.a.a.a",".a.a.a.a",".aaaaaaa",".aaaaaa.","..aaaaa.","..aaaa..","..aaaa.."]),undeliverable:P(["........",".aaaaa..","aoooooa.","aaaaaaaA","aaaaaaaA","aaaaaaa.","...a....","...a...."]),accepted:P(["....a...","...aa...","...aa...","AAaaaaa.","AAaaaaaa","AAaaaaa.","AAaaaaa.","AA.aaa.."]),declined:P(["aa....aa","aaa..aaa",".aaaaaa.","..aaaa..","..aaaa..",".aaaaaa.","aaa..aaa","aa....aa"]),later:P(["..AAAA..",".AwwwwA.","AwwwowwA","AwwwowwA","AwwwoowA","AwwwwwwA",".AwwwwA.","..AAAA.."]),daemon:P(["...aa...",".a.aa.a.","..aaaa..","aaaooaaa","aaaooaaa","..aaaa..",".a.aa.a.","...aa..."]),wake:P(["aa....aa","a.aaaa.a",".awwwwa.","awwowwwa","awwooowa","awwwwwwa",".aaaaaa.",".a....a."]),flag:P(["Aawaw...","Awawaw..","Aawawa..","Awawa...","A.......","A.......","A.......","AA......"]),tick:P(["........",".......a","......aa","a....aa.","aa..aa..",".aaaa...","..aa....","........"]),star:P(["...aa...","...aa...","aaaaaaaa",".aaaaaa.","..aaaa..",".aaaaaa.",".aa..aa.","a......a"]),snowflake:P(["...a....",".a.a.a..","..aaa...","aaaaaaa.","..aaa...",".a.a.a..","...a....","........"]),door:P([".aaaaaa.",".aoaaoa.",".aoaaoa.",".aaaaaa.",".aaaaAa.",".aoaaoa.",".aoaaoa.",".aaaaaa."]),speech:P([".wwwwww.","wwwwwwww","wwwwwwww","wwwwwwww",".wwwwww.","..ww....",".w......","........"]),bang:P(["...aa...","...aa...","...aa...","...aa...","...aA...","........","...aa...","...aa..."]),snail:P(["........","A.A.....","A.A.aaa.",".AAaAAaa",".AAaaAaa",".AAAaaaa",".AAAAAAA","........"]),ice:P(["llllllll","lwwaaaal","lwaaaaal","laaaaaal","laaaaaal","laaaaawl","laaaawwl","llllllll"]),paused:P(["aaaaaaaa","aaoaaoaa","aaoaaoaa","aaoaaoaa","aaaaaaaa","...AA...","...AA...","...AA..."]),zzz:P(["....wwww","......w.",".....w..","....wwww","www.....","..w.....",".w......","www....."]),parcel:P(["........","aaaAaaaa","aaaAaaaa","AAAAAAAA","aaaAaaaa","aaaAaaaa","aaaAaaaa","........"]),cart:P(["a.......",".a......",".aaaaaaa",".aaaaaaa",".aaaaaa.",".a......",".aaaaaa.","..A..A.."]),lockbox:P(["........",".aaaaaa.","aaaaaaaa","aaaAAaaa","aaaAAaaa","aaaaaaaa",".aaaaaa.","........"]),bin:P(["...aa...","aaaaaaaa",".aaaaaa.",".a.aa.a.",".a.aa.a.",".a.aa.a.",".aaaaaa.","........"]),lock:P(["..AAAA..",".A....A.",".A....A.","aaaaaaaa","aaaooaaa","aaaooaaa","aaaaaaaa","........"]),keyboard:P(["........","........","AAAAAAAA","AaAaAaAA","AAaAaAaA","AaaaaaaA","AAAAAAAA","........"]),clipboard:P(["aAa","awa","aaa"]),bolt:P([".aa",".a.","aa."]),version:P([".AAAAAA.","AAAAAAAA","AwAAAAwA","AwAAAAwA","AAwAAwAA","AAAwwAAA","AAAAAAAA",".AAAAAA."]),rules:P([".AAAAAA.","AAAAAwAA","AwwwwwwA","AAAAwAAA","AwwwwwwA","AAwAAAAA","AAAAAAAA",".AAAAAA."]),credit:P(["..aaaa..",".aaaaaa.","aaaAAaaa","aaAaaaaa","aaAaaaaa","aaaAAaaa",".aaaaaa.","..aaaa.."]),health:P(["...aa...","...aa...","..aooa..","..aooa..",".aaooaa.",".aaaaaa.","aaaooaaa","aaaaaaaa"]),plane:P([".......w",".....www","...wwwAw","wwwwwAw.","..AAAww.","...Aww..","...Aw...","...A...."]),sparkle:P(["...A....","...A....","..AwA...","AAwwwAA.","..AwA...","...A....","...A....","........"]),confetti:P(["a...A..w","..w...a.",".A..a...","....w.A.","a.A.....","...w..a.",".a...A..","w..a...A"]),stamp:P(["..aaaa..",".a....a.","a.a..a.a","a..aa..a","a..aa..a","a.a..a.a",".a....a.","..aaaa.."]),sign:P(["AAAAAA..","AAAAAAA.","AAAAAAAA","AAAAAAA.","AAAAAA..","...a....","...a....","...a...."]),cabinet:P([".aaaaaa.",".aaooaa.",".aaaaaa.",".oooooo.",".aaaaaa.",".aaooaa.",".aaaaaa.",".a....a."]),more:P([".AAAAAA.","AAAwwAAA","AAAwwAAA","AwwwwwwA","AwwwwwwA","AAAwwAAA","AAAwwAAA",".AAAAAA."]),caught_up:P(["........","a...a...","aa..aa..","aaa.aaa.","aaa.aaa.","aa..aa..","a...a...","........"]),you:P(["..aaaa..","..aaaa..","..aaaa..","aaaaaaaa",".aaaaaa.","..aaaa..","...aa...","........"]),think:P(["........","........","........","ww.ww.ww","ww.ww.ww","........","........","........"])}),Ce=Object.freeze({floorA:P(ce("aaaaaaaaaaaaaaaa",16)),floorB:P(ce("AAAAAAAAAAAAAAAA",16)),wall:P([...ce("oooooooooooooooo",12),...ce("kkkkkkkkkkkkkkkk",2),...ce("bbbbbbbbbbbbbbbb",2)]),door:P(["oooooooooooooooo",...ce("oohhhhhhhhhhhhoo",1),...ce("oohbbbbbbbbbbhoo",6),"oohbbbbbbbbhbhoo",...ce("oohbbbbbbbbbbhoo",5),...ce("oohhhhhhhhhhhhoo",2)]),desk:P([...ce("h".repeat(32),4),...ce("b".repeat(32),8),...ce(`.bb${".".repeat(26)}bb.`,4)]),monitor:P(["kkkkkkkkkkkk",...ce("kllllllllllk",5),"kkkkkkkkkkkk",".....kk.....","....kkkk...."]),chair:P([...ce("................",3),"....oooooooo....",...ce("....ohhhhhho....",3),"...oooooooooo...","...ohhhhhhhho...","...oooooooooo...",...ce("....o......o....",2),...ce("................",4)]),bigTable:P([`.${"h".repeat(62)}.`,...ce(`b${"h".repeat(62)}b`,21),...ce("b".repeat(64),6),...ce(`.bb${".".repeat(58)}bb.`,4)]),signPlate:P([...ce("................",2),"hhhhhhhhhhhhhhhh",...ce("kkkkkkkkkkkkkkkk",7),"hhhhhhhhhhhhhhhh",...ce("................",5)]),plaque:P(["h".repeat(20),...ce(`h${"k".repeat(18)}h`,4),"h".repeat(20)]),shelf:P(["b".repeat(32),...ce("blhkhlhkhlhkhlhkhlhkhlhkhlhkhlhb",6),"b".repeat(32),...ce("bhklhhklhhklhhklhhklhhklhhklhhkb",6),"b".repeat(32),`.b${".".repeat(28)}b.`])});function Pn(t,e){return t!=="squash"||e>3?e:e===3?null:e+1}var Ri=P(He.reduce((t,e,n)=>{let o=Pn("squash",n);return o!==null&&(t[o]=e),t},["................"])),vi=P(He.map((t,e)=>e===6?t.replace(/[wk]/g,"b"):e===7?t.replace(/[wk]/g,"o"):t)),Oi=Object.freeze({idle0:Object.freeze({map:He,dy:0}),idle1:Object.freeze({map:He,dy:-1}),squash:Object.freeze({map:Ri,dy:0}),rise:Object.freeze({map:He,dy:-2}),peak:Object.freeze({map:He,dy:-3}),land:Object.freeze({map:He,dy:-1}),eyesClosed:Object.freeze({map:vi,dy:0})});function Nn(t){return Oi[t]}function ht(t,e){if(!Number.isSafeInteger(t)||!Number.isSafeInteger(e)||t<0||e<0)throw new RangeError(`rgba: no buffer of ${t} x ${e}`);return{w:t,h:e,data:new Uint8ClampedArray(t*e*4)}}function zr(t,e,n,o,r){let s=t.data,a=(n*t.w+e)*4,l=s[a+3];if(r>=255||l===0){s[a]=o[0],s[a+1]=o[1],s[a+2]=o[2],s[a+3]=Math.min(255,r);return}let c=l*(255-r),f=r*255+c;for(let d=0;d<3;d++)s[a+d]=Math.round((o[d]*r*255+s[a+d]*c)/f);s[a+3]=Math.round(f/255)}function ke(t,e,n,o,r,s,a){let l=Math.round(o),c=Math.round(r);for(let f=0;f<e.length;f++){let d=c+f;if(d<0||d>=t.h)continue;let h=e[f],w=h.length;for(let A=0;A<w;A++){let S=l+A;if(S<0||S>=t.w)continue;let g=h[s?w-1-A:A];if(g===".")continue;let R=n(g);R!==null&&zr(t,S,d,R,a)}}}function ge(t,e,n,o,r,s=!1){ke(t,e,n,o,r,s,255)}function et(t){switch(t){case"a":return Ae.floorA;case"A":return Ae.floorB;case"o":return Ae.wall;case"b":return Ae.deskA;case"h":return Ae.deskB;case"k":return Ae.monitor;case"l":return Ae.screenIdle;default:return null}}var Ci=.5;function Vr(t){let e=et(t);return e===null?null:ze(e,Ae.wall,Ci)}function Bn(t){return e=>e==="a"?t[0]:e==="A"?t[1]:e==="o"?me.pupil:e==="w"?me.eyeWhite:e==="l"?me.lens:null}function Se(t){return Bn(Ze[t])}var zn=t=>t==="w"?me.eyeWhite:null;function Li(t){let e=Math.round((299*t[0]+587*t[1]+114*t[2])/1e3);return[e,e,e]}function xi(t,e,n){let o=r=>{switch(r){case"o":case"f":return n;case"b":return t.body;case"h":return t.highlight;case"c":return me.cheek;case"w":return me.eyeWhite;case"k":return me.pupil;case"a":return t.accessory[0];case"A":return t.accessory[1];case"l":return me.lens;default:return null}};return e?r=>{let s=o(r);return s===null?null:Li(s)}:o}var Ti=Object.freeze(["beanie","headphones","sunglasses","scarf","sprout","cap","bow","glasses"]);function Hr(t){let e=t!==void 0&&Number.isInteger(t.hue)&&t.hue>=0&&t.hue<It.characters.length,n=It.characters[e?t.hue:0],r=t!==void 0&&Number.isInteger(t.accessory)&&t.accessory>=0&&t.accessory<n.length?t.accessory:0;return{colours:n[r],accessory:Ti[r]}}var Zn=10,jr=-5,Di=12,Pi=6,Ni=6,Vi=12,Ui=4,Zi=6,Fi=2*16,Bi=16;function zi(t,e,n,o,r,s){let a=[];for(let l=0;l<o;l++)a.push([e+l,n]);for(let l=1;l<r;l++)a.push([e+o-1,n+l]);for(let l=o-2;l>=0;l--)a.push([e+l,n+r-1]);for(let l=r-2;l>=1;l--)a.push([e,n+l]);a.forEach(([l,c],f)=>{!(f>>1&1)&&l>=0&&c>=0&&l<t.w&&c<t.h&&zr(t,l,c,s,255)})}function Gr(t){let e=[...String(t)].map(n=>Nr[n.charCodeAt(0)-48]);return Array.from({length:5},(n,o)=>e.map(r=>r[o]).join("."))}function qr(t,e){let{w:n,h:o}=We(t),r=ht(n*16,o*16);for(let c=0;c<o;c++)for(let f=0;f<n;f++)ge(r,(f+c)%2===0?Ce.floorA:Ce.floorB,et,f*16,c*16);for(let c=0;c<n;c++)ge(r,c===de.x?Ce.door:Ce.wall,et,c*16,de.y*16);for(let c of t.zones)for(let f of c.cells){let d=st(f);for(let h=0;h<Zi;h++)ge(r,Ce.signPlate,et,(d.x+h)*16,d.y*16)}let s=we(t,0),a=e.dimmed.has(0)?Vr:et;if(ge(r,Ce.bigTable,a,s.desk[0].x*16,s.desk[0].y*16),ge(r,Ce.chair,a,s.chair.x*16,s.chair.y*16),e.coarse){for(let c of t.zones){let f=c.cells[0];if(f===void 0)continue;let d=st(f),h=(d.x+1)*16,w=(d.y+3)*16;ge(r,Ce.bigTable,et,h,w);let A=Gr(t.desks.filter(S=>S.zone===c.index).length);ge(r,A,zn,h+32-Math.floor(A[0].length/2),w+10)}return r}let l=e.dashedFrom===null?null:{height:e.dashedFrom,sub:0,k:0};for(let c of t.desks){if(c.kind==="big_table"||c.cell===null||c.slot===null)continue;let f=we(t,c.ordinal),d=f.desk[0].x*16,h=f.desk[0].y*16;if(xo(c,l)){zi(r,d,h,Fi,Bi,Ae.deskB);continue}let w=e.dimmed.has(c.ordinal)?Vr:et;ge(r,Ce.chair,w,f.chair.x*16,f.chair.y*16),c.kind==="shelf"?ge(r,Ce.shelf,w,d,h):(ge(r,Ce.desk,w,d,h),ge(r,Ce.monitor,w,d+Zn,h+jr)),e.lockboxDesks.has(c.ordinal)?ge(r,pe.lock,Se("lock"),d+Vi,h+Ui):ge(r,Ce.plaque,w,d+Pi,h+Ni)}return r}function $t(t,e,n){if(t.at!=="home"&&t.at!=="behind"&&!dt(e,t.desk))return{x:de.x,y:de.y};switch(t.at){case"home":return Lo(t.spot);case"chair":return we(e,t.desk).chair;case"stool":return we(e,t.desk).visitors[0];case"visitor":{let o=we(e,t.desk).visitors;return o[Math.min(Math.max(0,t.tile),o.length-1)]??o[0]}case"beside":{let o=we(e,t.desk).visitors;return o[Math.min(n.desks.get(t.desk)?.visitors.length??0,o.length-1)]}case"facing":{let o=we(e,t.desk).chair;for(let[r,s]of[[0,1],[-1,0],[1,0],[0,-1]]){let a={x:o.x+r,y:o.y+s};if(!at(e,a))return a}return o}case"behind":{let o=n.characters.get(t.peer);if(o===void 0||o.place.at==="behind")return{x:de.x,y:de.y};let r=$t(o.place,e,n),s={x:r.x,y:r.y+1};if(!at(e,s))return s;let a={x:r.x,y:r.y-1};return at(e,a)?r:a}}}var Hi=128,ji=128,Gi=80,tt=8,ft=1,qi=2,Ki=8,Ur=4,$i=8,Zr=4,Wi=Object.freeze(["ww","ww"]),Ne=t=>({icon:t,tones:Ze[t],jump:!1}),Fr=Object.freeze({queued_until_turn_end:"queued",asked:"asked",awaiting_human:"awaiting_human",undeliverable:"undeliverable"}),Br=Object.freeze({accept:"accepted",grant:"accepted",decline:"declined",later:"later"});function Yi(t){let e={pops:new Map,exclaim:new Map,published:new Set},n=(o,r)=>{if(r===void 0)return;let s=e.pops.get(o);s===void 0?e.pops.set(o,[r]):s.push(r)};for(let o of t)switch(o.kind){case"person_badge":o.on&&(o.badge==="version"||o.badge==="health")&&n(j(o.actor),o.badge);break;case"publish":e.published.add(j(o.actor)),o.origin==="wake"&&n(j(o.actor),"wake");break;case"pet_spawn":n(j({seat:o.seat}),"think");break;case"request_status":n(j(o.holder),Object.hasOwn(Fr,o.status)?Fr[o.status]:void 0);break;case"answer":n(j(o.holder),o.by==="daemon"?"daemon":Object.hasOwn(Br,o.verb)?Br[o.verb]:void 0);break;case"request_open":o.requestKind==="handoff"&&n(j(o.from),"parcel");break;case"conflict":e.exclaim.set(j(o.on),Ze.bang);break;case"person_bang":e.exclaim.set(j({peer:o.peer}),Or);break;default:break}return e}function Kr(t,e,n,o,r){e.forEach((s,a)=>ke(t,pe[s.icon],Bn(s.tones),n+a*(tt+ft),o-(s.jump?qi:0),!1,r))}var Xi=t=>t*(tt+ft)-ft;function $r(t,e){let n=t.marks.exclaim.get(e);return n!==void 0?{icon:"bang",tones:n,jump:!t.phase.reduced}:t.bangOn.has(e)?Ne("bang"):null}var Vn=9,Ji=4,Qi=Object.freeze(He.map((t,e)=>e===6?t.replace(/k/g,"w"):e===7?t.replace(/w/g,"k"):t)),el=Object.freeze(["aaaAAaaa","aaaAAaaa","aaaAAaaa"]),tl=4,nl=9;function Wr(t,e){let n=t==="idle0"?1:t==="idle1"?-1:0;return e?-n:n}function Fn(t,e,n,o,r,s,a,l,c){if(c===0){ke(t,e,n,o,r,s,a);return}ke(t,e.slice(0,l),n,o+c,r,s,a),ke(t,e.slice(l),n,o,r+l,s,a)}function ol(t,e,n,o,r){let{out:s,phase:a}=t,l=a.frame(e);o.absent?l="eyesClosed":l!=="eyesClosed"&&(a.reduced||o.frozen!==null)&&(l="idle0");let c=o.pose==="relaxed"&&(l==="idle0"||l==="idle1"),f=a.facingLeft(e),d=c?Wr(l,f):0,{map:h,dy:w}=c?{map:Qi,dy:0}:Nn(l),A=Math.round(r.x*16),S=Math.round(r.y*16)+w,g=o.ghost?Hi:255,{colours:R,accessory:p}=Hr(t.looks.get(n)),E=t.marks.exclaim.get(e),V=xi(R,o.ghost,a.reduced&&E!==void 0?E[0]:R.outline);Fn(s,h,V,A,S,f,g,Vn,d);for(let[z,H]of Tr[p]){let Q=Pn(l,z);Q!==null&&ke(s,[H],V,A+(z<Vn?d:0),S+Q,f,g)}c&&ke(s,el,V,A+tl,S+nl,f,g),o.frozen!==null&&o.frozen!=="PAUSED"&&Fn(s,h,()=>Ze.ice[0],A,S,f,Gi,Vn,d);let C=[],X=$r(t,e);X!==null&&C.push(X),o.frozen!==null&&C.push(Ne(o.frozen==="PAUSED"?"paused":"ice")),o.slowedUntil!==null&&t.scene.at.height<o.slowedUntil&&C.push(Ne("snail")),o.absent&&C.push(Ne("zzz")),o.rules&&C.push(Ne("rules")),o.credit&&C.push(Ne("credit"));for(let z of t.marks.pops.get(e)??[])C.push(Ne(z));a.reduced&&o.pose==="sit"&&t.marks.published.has(e)&&C.push(Ne("keyboard")),Kr(s,C,A+16/2-Math.floor(Xi(C.length)/2),S-tt,g)}function rl(t,e){if(!Number.isSafeInteger(t)||t<=0)return null;let n=Pr[t];return n!==void 0?n===null?null:{map:n,colour:Bn([e.highlight,e.body])}:{map:Gr(t),colour:zn}}function sl(t,e,n,o,r){let{out:s,phase:a}=t,l=a.reduced?"idle0":a.frame(e),c=o.pose==="relaxed"&&(l==="idle0"||l==="idle1"),f=a.facingLeft(e),d=c?Wr(l,f):0,h=c?0:Nn(l).dy,w=Math.round(r.x*16)+Ur,A=Math.round(r.y*16)+$i+h,{colours:S}=Hr(t.looks.get(o.owner)),g=0,R=0;for(let oe of t.scene.claims.values())oe.seat===n&&(g++,oe.stale&&R++);let p=g>0&&R===g?ji:255,E=t.marks.exclaim.get(e),V=a.reduced&&E!==void 0?E[0]:S.outline,C=ze(S.highlight,me.eyeWhite,.35);Fn(s,Dr,oe=>oe==="o"?V:oe==="b"?S.highlight:oe==="h"?C:oe==="c"?me.cheek:oe==="k"?me.pupil:null,w,A,f,p,Ji,d);let z=rl(o.variant,S);z!==null&&ke(s,z.map,z.colour,w+d+Ur-Math.floor(z.map[0].length/2),A-z.map.length,!1,p);let H=[],Q=$r(t,e);Q!==null&&H.push(Q),o.ssCode!==null&&H.push(Ne("health"));for(let oe of t.marks.pops.get(e)??[])H.push(Ne(oe));a.reduced&&o.pose==="sit"&&t.marks.published.has(e)&&H.push(Ne("keyboard")),Kr(s,H,w+Ki+ft,A,p)}function dt(t,e){if(!Number.isSafeInteger(e)||e<0||e>=t.desks.length)return!1;let n=t.desks[e];return n.kind==="big_table"||n.cell!==null&&n.slot!==null}function Kt(t,e){let n=we(t,e).desk[0];return{x:n.x*16,y:n.y*16}}function Yr(t){return Object.freeze(t.map((e,n)=>[...e].map((o,r)=>{if(o===".")return".";let s=(a,l)=>t[l]?.[a]??".";return s(r-1,n)==="."||s(r+1,n)==="."||s(r,n-1)==="."||s(r,n+1)==="."?o:"."}).join("")))}var al=Yr(pe.cabinet),il=Yr(pe.parcel),Un=3;function ll(t){return t.localOnly?{map:pe.lockbox,icon:"lockbox"}:t.residence==="INCOMING"?{map:pe.cart,icon:"cart"}:t.residence==="OFF_DISK"||t.residence==="PARKED"?{map:il,icon:"parcel"}:{map:pe.parcel,icon:"parcel"}}function Xr(t,e,n,o){let{w:r,h:s}=We(e),a=ht(r*16,s*16),l=new Set;for(let g of t.bangs.values())l.add(j(g.on));let c={out:a,scene:t,looks:n,phase:o,marks:Yi(t.beat),bangOn:l},f=o.reduced;for(let g of e.desks){if(g.kind==="big_table"||g.kind==="shelf"||g.cell===null||o.screen(g.ordinal)!=="published")continue;let R=Kt(e,g.ordinal);ke(a,Ce.monitor,p=>p==="l"?Ae.screenPublished:null,R.x+Zn,R.y+jr,!1,255)}let d=new Map,h=(g,R)=>{let p=Kt(e,g);return{x:p.x+(g===0?4:1)+R*(tt+ft),y:p.y+(g===0?4:-3)}};for(let[,g]of[...t.boxes].sort(([R],[p])=>R<p?-1:R>p?1:0)){if(!dt(e,g.desk))continue;let R=d.get(g.desk)??0;if(d.set(g.desk,R+1),R>=Un)continue;let{map:p,icon:E}=ll(g),V=h(g.desk,R);ke(a,p,Se(E),V.x,V.y,!1,255)}for(let[g,R]of d){if(R<=Un)continue;let p=h(g,Un);ke(a,pe.more,Se("more"),p.x,p.y,!1,255)}for(let[g,R]of[...t.desks].sort(([p],[E])=>p-E)){if(R.more<=0||!dt(e,g))continue;let p=we(e,g).chair,E=g===0?{x:20*16+4,y:18}:{x:(p.x+2)*16+4,y:(p.y+1)*16+4};ke(a,pe.more,Se("more"),E.x,E.y,!1,255)}let w=g=>g.at==="visitor"&&g.tile>=4,A=[];for(let[g,R]of t.characters){if(w(R.place))continue;let p=j({peer:g}),E=o.tile(p);A.push({key:p,foot:Math.round(E.y*16)+16-1,draw:()=>ol(c,p,g,R,E)})}for(let[g,R]of t.pets){if(!R.live||w(R.place))continue;let p=j({seat:g}),E=o.tile(p);A.push({key:p,foot:Math.round(E.y*16)+16-1,draw:()=>sl(c,p,g,R,E)})}A.sort((g,R)=>g.foot-R.foot||(g.key<R.key?-1:g.key>R.key?1:0));for(let g of A)g.draw();let S=(g,R)=>{let p=Kt(e,g);R.forEach((E,V)=>{let C=V===0?0:Zn+Di+(V-1)*(tt+ft);ke(a,pe[E],Se(E),p.x+C,p.y-tt,!1,255)})};for(let g of t.beat)if(g.kind==="publish"){if(dt(e,g.target)){let R=[f?"star":"sparkle"];g.state==="closed"&&R.push("flag"),g.checks==="pass"&&R.push("tick"),g.others.length>Zr&&R.push("more"),S(g.target,R)}for(let R of g.others.slice(0,Zr)){if(!dt(e,R))continue;let p=Kt(e,R);f?ke(a,Wi,zn,p.x+3,p.y-5,!1,255):ke(a,pe.plane,Se("plane"),p.x,p.y-tt,!1,255)}}else if(g.kind==="save")for(let R of g.desks)dt(e,R)&&S(R,[f?"stamp":"confetti"]);return t.branchMovedAt!==null&&t.at.height-t.branchMovedAt<Fo&&ke(a,pe.sign,Se("sign"),(de.x+1)*16+4,de.y*16+4,!1,255),t.badge!=="none"&&ke(a,t.badge==="full"?pe.cabinet:al,Se("cabinet"),20*16+4,4,!1,255),a}var cl=new Intl.Segmenter("en",{granularity:"grapheme"}),ul=/[\\u{3041}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{31F0}-\\u{31FF}\\u{FF66}-\\u{FF9F}\\u{1B000}-\\u{1B16F}]/u,dl=new RegExp("^\\\\p{Script=Hangul}","u"),fl=new RegExp("^\\\\p{Script=Han}","u"),hl=/^[\\u{1100}-\\u{115F}\\u{2E80}-\\u{303E}\\u{3041}-\\u{33FF}\\u{3400}-\\u{4DBF}\\u{4E00}-\\u{9FFF}\\u{A000}-\\u{A4CF}\\u{A960}-\\u{A97F}\\u{AC00}-\\u{D7A3}\\u{F900}-\\u{FAFF}\\u{FE30}-\\u{FE4F}\\u{FF00}-\\u{FF60}\\u{FFE0}-\\u{FFE6}\\u{1F300}-\\u{1F64F}\\u{1F900}-\\u{1F9FF}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}]/u,pl="…",ml=42/16,ts=t=>Array.from(cl.segment(t),e=>e.segment),Jr=t=>hl.test(t)?ml:1,Yt=t=>/^\\s+$/u.test(t),gl=t=>Number.isFinite(t)&&t>0?t:1;function bl(t,e){let n=ts(t),o;if(ul.test(t))o=500+n.length*1e3/4;else{let s=0,a=0,l=0;for(let c of n)dl.test(c)?a++:fl.test(c)?l++:s++;o=500+s*1e3/20+a*1e3/12+l*1e3/9}let r=Math.min(6e3,Math.max(1500,o));return Math.max(1e3,r/gl(e))}function Qr(t,e,n){let o=e,r=0;for(;o<t.length&&r+Jr(t[o])<=n;)r+=Jr(t[o++]);return{end:o,width:r}}var es=(t,e)=>{let n=e;for(;n<t.length&&Yt(t[n]);)n++;return n},Wt=(t,e,n)=>{let o=n;for(;o>e&&Yt(t[o-1]);)o--;return o};function _l(t){let e=ts(t),n=[],o=es(e,0);for(;o<e.length&&n.length<2;){let{end:r}=Qr(e,o,42);if(r>=Wt(e,o,e.length))return n.push(e.slice(o,Wt(e,o,e.length)).join("")),n;if(n.length===1){let{end:a}=Qr(e,o,41);return n.push(e.slice(o,Wt(e,o,a)).join("")+pl),n}let s=r;if(!Yt(e[r])){let a=r-1;for(;a>o&&!Yt(e[a]);)a--;a>o&&(s=a)}n.push(e.slice(o,Wt(e,o,s)).join("")),o=es(e,s)}return n}var Xt=class{rooms=new Map;seq=0;show(e,n,o,r,s){this.prune(r);let a=this.rooms.get(n);for(a===void 0&&(a=new Map,this.rooms.set(n,a)),a.delete(e);a.size>=3;){let l=null;for(let c of a.values())(l===null||c.shownMs<l.shownMs||c.shownMs===l.shownMs&&c.seq<l.seq)&&(l=c);a.delete(l.actor)}a.set(e,{actor:e,room:n,lines:_l(o),shownMs:r,untilMs:r+bl(o,s),seq:this.seq++})}active(e){this.prune(e);let n=[];for(let o of this.rooms.values())n.push(...o.values());return n.sort((o,r)=>o.seq-r.seq),n.map(o=>({actor:o.actor,lines:[...o.lines],untilMs:o.untilMs}))}prune(e){for(let[n,o]of this.rooms){for(let[r,s]of o)s.untilMs<=e&&o.delete(r);o.size===0&&this.rooms.delete(n)}}};var Al=83.33333333333333;function ns(t,e,n,o){let r=null,s=!1,a=null,l=Number.NEGATIVE_INFINITY,c=!1,f=0,d=()=>{r===null&&(r=t.raf(h))},h=w=>{r=null;let A=e(w),S=c||A!==a;S&&w-l>=Al&&(c=!1,o(w),f++,l=w,a=A,S=!1),(S||!n(w))&&!s&&d()};return{wake(){s=!1,c=!0,d()},stop(){s=!0,r!==null&&t.cancel(r),r=null},draws:()=>f}}var yl=[0,1,0,-1],wl=[-1,0,1,0],os=4,Hn=class{items=[];seq=0;get size(){return this.items.length}push(e,n,o){let r={s:e,f:n,h:o,seq:this.seq++},s=this.items;s.push(r);let a=s.length-1;for(;a>0;){let l=a-1>>1;if(!this.less(s[a],s[l]))break;[s[a],s[l]]=[s[l],s[a]],a=l}}pop(){let e=this.items,n=e[0],o=e.pop();if(e.length>0){e[0]=o;let r=0;for(;;){let s=2*r+1,a=s+1,l=r;if(s<e.length&&this.less(e[s],e[l])&&(l=s),a<e.length&&this.less(e[a],e[l])&&(l=a),l===r)break;[e[r],e[l]]=[e[l],e[r]],r=l}}return n.s}less(e,n){return e.f!==n.f?e.f<n.f:e.h!==n.h?e.h<n.h:e.seq<n.seq}};function rs(t,e,n,o){let{w:r,h:s}=o,a=(p,E)=>Number.isSafeInteger(p)&&Number.isSafeInteger(E)&&p>=0&&E>=0&&p<r&&E<s;if(!a(t.x,t.y)||!a(e.x,e.y)||n(e))return null;if(t.x===e.x&&t.y===e.y)return[{x:t.x,y:t.y}];let l=r*s*5,c=new Float64Array(l).fill(Number.POSITIVE_INFINITY),f=new Int32Array(l).fill(-1),d=new Uint8Array(l),h=new Int8Array(r*s),w=(p,E)=>{let V=E*r+p;return h[V]===0&&(h[V]=n({x:p,y:E})?2:1),h[V]===1},A=(p,E)=>Math.abs(e.x-p)+Math.abs(e.y-E),S=(p,E,V)=>(E*r+p)*5+V,g=new Hn,R=S(t.x,t.y,os);for(c[R]=0,g.push(R,A(t.x,t.y),A(t.x,t.y));g.size>0;){let p=g.pop();if(d[p]===1)continue;d[p]=1;let E=p%5,V=(p-E)/5,C=V%r,X=(V-C)/r;if(C===e.x&&X===e.y){let z=[];for(let H=p;H!==-1;H=f[H]){let Q=(H-H%5)/5;z.push({x:Q%r,y:(Q-Q%r)/r})}return z.reverse()}for(let z=0;z<4;z++){let H=C+yl[z],Q=X+wl[z];if(!a(H,Q)||!w(H,Q))continue;let oe=S(H,Q,z);if(d[oe]===1)continue;let Ie=c[p]+1+(E!==os&&E!==z?1:0);if(Ie<c[oe]){c[oe]=Ie,f[oe]=p;let re=A(H,Q);g.push(oe,Ie+re,re)}}}return null}var Jt=class{constructor(e){this.max=e}entries=new Map;get(e,n,o,r){let s=`${e}|${n.x},${n.y}|${o.x},${o.y}`,a;if(this.entries.has(s))a=this.entries.get(s),this.entries.delete(s);else{let l=r();for(a=l===null?null:l.map(c=>({x:c.x,y:c.y}));this.entries.size>=this.max&&this.entries.size>0;)this.entries.delete(this.entries.keys().next().value)}return this.entries.set(s,a),a===null?null:a.map(l=>({x:l.x,y:l.y}))}};function ss(t,e){return t===null||e>=4&&t.length-1>12}function as(t,e){return Number.isFinite(t)&&Number.isFinite(e)&&t>0&&e>0?Math.max(2,Math.floor(t/e)):2}function kl(t){return Number.isFinite(t)?Math.min(8,Math.max(2,Math.round(t))):Number.isNaN(t)?2:t>0?8:2}function jn(t){return Math.max(1,t-1)}var Qt=class{constructor(e){this.worldW=e}zoom=2;coarseView=!1;get z(){return this.zoom}get coarse(){return this.coarseView}open(e){this.zoom=as(e,this.worldW)}resize(e){this.zoom=as(e,this.worldW)}userZoom(e){this.zoom=kl(this.zoom+e)}officeGrew(){}toggleCoarse(){this.coarseView=!this.coarseView}},en=class{last=null;scrolled(e){this.last=e}follow(e){return this.last===null||e-this.last>=3e4}};var is=Object.freeze(["squash","rise","peak","land"]),El=100,ls=600,Sl=900,Rl=512,vl=600,pt=48,nt=32,mt=4,cs=2,us=8,Ol=11,ds=9,Ml=2,Cl="(prefers-color-scheme: dark)";function fs(t){return`#${t.map(e=>e.toString(16).padStart(2,"0")).join("")}`}function ot(t,e,n,o,r,s){for(let a=Math.max(0,n);a<Math.min(t.h,n+r);a++)for(let l=Math.max(0,e);l<Math.min(t.w,e+o);l++){let c=(a*t.w+l)*4;t.data[c]=s[0],t.data[c+1]=s[1],t.data[c+2]=s[2],t.data[c+3]=255}}function Gn(t,e,n,o,r,s){ot(t,e,n,o,1,s),ot(t,e,n+r-1,o,1,s),ot(t,e,n,1,r,s),ot(t,e+o-1,n,1,r,s)}function qn(t,e){t.width!==e.w&&(t.width=e.w),t.height!==e.h&&(t.height=e.h);let n=t.getContext("2d");if(n===null)return;let o=n.createImageData(e.w,e.h);o.data.set(e.data),n.putImageData(o,0,0)}function hs(t,e,n,o){let{t:r}=o,s=new Qt(21*16),a=new en,l=new Jt(Rl),c=new Xt,f=new Map,d=document.createElement("canvas"),h=document.createElement("canvas"),w=window.matchMedia(Cl),A=!1,S=null,g=null,R=!0,p=null,E="",V=!1,C=new Map,X=()=>Number.isFinite(window.devicePixelRatio)&&window.devicePixelRatio>0?window.devicePixelRatio:1,z=()=>o.reduced()||o.paused(),H=(m,I)=>m.path!==null&&I<m.t0+m.dur,Q=(m,I)=>{if(m.path===null||!H(m,I)||m.path.length<2)return m.to;let _=Math.max(0,Math.min(1,(I-m.t0)/m.dur))*(m.path.length-1),L=Math.min(m.path.length-2,Math.floor(_)),T=m.path[L],x=m.path[L+1],W=_-L;return{x:T.x+(x.x-T.x)*W,y:T.y+(x.y-T.y)*W}},oe=(m,I)=>{if(H(m,I))return is[Math.floor(Math.max(0,I-m.t0)/El)%is.length];if(z())return"idle0";let _=m.pose==="relaxed"?Sl:ls;return Math.floor(Math.max(0,I+m.phase)/_)%2===0?"idle0":"idle1"},Ie=(m,I)=>{let _=new Map,L=0;for(let[T,x]of m.characters)_.set(j({peer:T}),{to:$t(x.place,I,m),pose:x.pose,seed:L++,peer:T});for(let[T,x]of m.pets)x.live&&_.set(j({seat:T}),{to:$t(x.place,I,m),pose:x.pose,seed:L++,peer:null});return _},re=(m,I)=>{let _=S?.layout;if(g=m,R=I.live,p=I.overlay,_===void 0)return;let L=performance.now(),T=Number.isFinite(I.speed)&&I.speed>0?I.speed:1,x=I.animate&&!z(),W=Ie(m,_),Y=We(_);for(let F of[...C.keys()])W.has(F)||C.delete(F);for(let[F,q]of W){let Z=C.get(F),ae=q.seed%2===0?0:ls;if(Z===void 0){let Le=q.peer!==null&&x?{x:de.x,y:de.y}:null;C.set(F,{to:q.to,path:null,t0:L,dur:0,left:!1,phase:ae,pose:q.pose,peer:q.peer}),Le!==null&&D(C.get(F),Le,q.to,_,Y,T,L);continue}if(Z.pose=q.pose,Z.to.x===q.to.x&&Z.to.y===q.to.y)continue;let ve=Q(Z,L);Z.to=q.to,Z.path=null,x&&D(Z,{x:Math.round(ve.x),y:Math.round(ve.y)},q.to,_,Y,T,L)}if(x&&S!==null)for(let F of m.beat)F.kind==="request_open"&&F.note!==null?c.show(j(F.from),S.id,F.note,L,T):F.kind==="answer"&&F.note!==null?c.show(j(F.holder),S.id,F.note,L,T):F.kind==="note"&&c.show(j(F.actor),S.id,F.text,L,T);Re.wake()},D=(m,I,_,L,T,x,W)=>{let Y=l.get(L.version,I,_,()=>rs(I,_,F=>at(L,F),T));ss(Y,x)||Y===null||Y.length<2||(m.path=Y,m.t0=W,m.dur=Math.min((Y.length-1)/$o*1e3,Wo)/x,m.left=_.x<I.x)},$=(m,I)=>{let _=w.matches,L=`${_?1:0}|${I}|${m}`,T=f.get(L);if(T!==void 0)return T;f.size>=vl&&f.clear();let x=document.createElement("canvas"),W=x.getContext("2d"),Y=`${Math.round(I)}px system-ui, sans-serif`,F=1;W!==null&&(W.font=Y,F=Math.max(1,Math.ceil(W.measureText(m).width)));let q=Math.round(Ml*X());x.width=F+2*q,x.height=Math.ceil(I*1.3)+2*q;let Z=x.getContext("2d");return Z!==null&&(Z.fillStyle=fs(_?Ae.wall:me.eyeWhite),Z.fillRect(0,0,x.width,x.height),Z.font=Y,Z.textBaseline="top",Z.fillStyle=fs(_?me.eyeWhite:me.pupil),Z.fillText(m,q,q)),f.set(L,x),x},G=(m,I,_,L,T)=>{let x=$(I,_);m.drawImage(x,Math.round(L-x.width/2),Math.round(T-x.height))},ee=(m,I,_,L)=>{let T=I*L,x=_*L;m.width!==T&&(m.width=T),m.height!==x&&(m.height=x);let W=X();m.style.width=`${T/W}px`,m.style.height=`${x/W}px`},te=m=>{let I=g,_=new Set;for(let T of I.beat)T.kind==="publish"&&_.add(T.target);let L=S.layout;return{reduced:o.reduced(),frame:T=>{let x=C.get(T);return x===void 0?"idle0":oe(x,m)},tile:T=>{let x=C.get(T);return x===void 0?{x:de.x,y:de.y}:Q(x,m)},facingLeft:T=>C.get(T)?.left??!1,screen:T=>_.has(T)&&we(L,T).desk.length>0?"published":"idle"}},fe=(m,I)=>{let _=ur(p,!R);if(_===null)return null;let L=_.you!==null&&g.characters.has(_.you)?I.tile(j({peer:_.you})):null;return L!==null&&(ge(m,pe.you,Se("you"),Math.round(L.x*16)+4,Math.round(L.y*16)-2*16),_.parcels>0&&ge(m,pe.parcel,Se("parcel"),Math.round(L.x*16)+16,Math.round(L.y*16)+4)),_.cart>0&&ge(m,pe.cart,Se("cart"),(de.x+1)*16,(de.y+1)*16),_.boxes>0&&ge(m,pe.parcel,Se("parcel"),(de.x+1)*16+9,(de.y+1)*16),{you:L,parcels:_.parcels,cart:_.cart,boxes:_.boxes}},U=m=>{let I=t.getContext("2d");if(I===null)return;if(S===null||g===null){I.clearRect(0,0,t.width,t.height);return}let _=S.layout,L=g,T=We(_),x=T.w*16,W=T.h*16,Y=s.z;ee(t,x,W,Y);let F=fr(_,L,{live:R,coarse:s.coarse}),q=`${_.version}|${F.dashedFrom}|${[...F.dimmed].join(",")}|${F.coarse}|${[...F.lockboxDesks].join(",")}`;(q!==E||d.width!==x||d.height!==W)&&(qn(d,qr(_,F)),E=q);let Z=te(m),ae=Xr(L,_,S.looks,Z),ve=fe(ae,Z);qn(h,ae),I.imageSmoothingEnabled=!1,I.clearRect(0,0,t.width,t.height),I.drawImage(d,0,0,x*Y,W*Y),I.drawImage(h,0,0,x*Y,W*Y),J(I,L,_,Z,Y,m,ve)},J=(m,I,_,L,T,x,W)=>{let Y=X(),F=Ol*Y,q=ds*Y,Z=K=>K*T,ae=S.layoutVM;if(!s.coarse){for(let K of ae.zones)for(let he of K.cells){let ie=st(he);G(m,K.sign,q,Z((ie.x+3)*16),Z(ie.y*16+12))}for(let K of ae.desks){if(K.kind==="big_table"||K.cell===null||K.slot===null||K.ordinal>=_.desks.length)continue;let he=we(_,K.ordinal).desk[0],ie=K.kind==="shelf"?r("UI_VIZ_SHELF_DESK",{zone:ae.zones[K.zone??-1]?.sign??"?"}):K.plaque;ie!==null&&G(m,ie,q,Z(he.x*16+16),Z(he.y*16+16+6))}}for(let[K,he]of I.desks){if(he.more<=0||K>=_.desks.length)continue;let ie=we(_,K).chair,Oe=K===0?{x:20*16+4,y:18}:{x:(ie.x+2)*16+4,y:(ie.y+1)*16+4};G(m,r("UI_VIZ_MORE",{n:he.more}),q,Z(Oe.x+4),Z(Oe.y))}let ve=new Map;for(let K of I.boxes.values())ve.set(K.desk,(ve.get(K.desk)??0)+1);for(let[K,he]of ve){if(he<=3||K>=_.desks.length)continue;let ie=we(_,K).desk[0],Oe=ie.x*16+(K===0?4:1)+3*9,Te=ie.y*16+(K===0?4:-3);G(m,r("UI_VIZ_MORE",{n:he-3}),q,Z(Oe+4),Z(Te))}for(let K of I.beat)K.kind==="publish"&&K.target===0&&G(m,r("UI_VIZ_BIG_TABLE",{n:K.n}),q,Z(19*16),Z(16));let Le=o.highlighted();for(let[K,he]of I.characters){if(he.place.at==="visitor"&&he.place.tile>=4)continue;let ie=L.tile(j({peer:K})),Oe=Z(ie.x*16+16/2);if(G(m,S.names.get(K)??K,F,Oe,Z(ie.y*16-9)),K===Le){let Te=Rn(r,At(I,{peer:K},_));Te!==null&&G(m,Te,q,Oe,Z(ie.y*16+16)+q*1.6)}}W!==null&&(W.you!==null&&(G(m,r("UI_VIZ_YOU"),F,Z(W.you.x*16+16/2),Z(W.you.y*16-2*16-1)),W.parcels>1&&G(m,r("UI_VIZ_MORE",{n:W.parcels}),q,Z(W.you.x*16+16+12),Z(W.you.y*16+4))),W.cart>1&&G(m,r("UI_VIZ_MORE",{n:W.cart}),q,Z((de.x+1)*16+4),Z((de.y+1)*16)),W.boxes>1&&G(m,r("UI_VIZ_MORE",{n:W.boxes}),q,Z((de.x+1)*16+13),Z((de.y+1)*16)));for(let K of c.active(x)){let he=C.get(K.actor);if(he===void 0)continue;let ie=Q(he,x);K.lines.forEach((Oe,Te)=>{G(m,Oe,F,Z(ie.x*16+16/2),Z(ie.y*16-9)-F*1.4*(K.lines.length-Te))})}},Re=ns({raf:m=>requestAnimationFrame(m),cancel:m=>cancelAnimationFrame(m)},m=>{let I=[];for(let[_,L]of C){let T=Q(L,m);I.push(`${_}:${oe(L,m)}:${Math.round(T.x*16)}:${Math.round(T.y*16)}`)}return I.push(String(c.active(m).length)),I.join("|")},m=>{if(g===null||S===null||C.size===0)return c.active(m).length===0;if(!z())return!1;for(let I of C.values())if(H(I,m))return!1;return c.active(m).length===0},U);t.addEventListener("click",m=>{if(S===null||g===null)return;let I=s.z,_=X(),L=m.offsetX*_/I,T=m.offsetY*_/I,x={x:Math.floor(L/16),y:Math.floor(T/16)},W=performance.now();for(let[Y]of g.characters){let F=C.get(j({peer:Y}));if(F===void 0)continue;let q=Q(F,W);if(Math.round(q.x)===x.x&&Math.round(q.y)===x.y)return o.person(Y)}for(let[Y,F]of g.pets){let q=C.get(j({seat:Y}));if(q===void 0||!F.live)continue;let Z=Q(q,W);if(Math.round(Z.x)===x.x&&Math.round(Z.y)===x.y)return o.person(F.owner)}for(let Y of S.layout.desks)if(!(Y.kind!=="big_table"&&(Y.cell===null||Y.slot===null))&&we(S.layout,Y.ordinal).desk.some(F=>F.x===x.x&&F.y===x.y))return o.desk(Y.ordinal)}),n.addEventListener("scroll",()=>{V?V=!1:a.scrolled(performance.now())});let le=[];e.addEventListener("click",m=>{let I=nt*jn(s.z)/X(),_=Math.floor(m.offsetY/I),L=le[_];L!==void 0&&o.selectRoom(L.id)});let tn=(m,I,_)=>{le=m;let L=jn(s.z),T=ht(pt,Math.max(1,nt*m.length)),x=ze(Ae.wall,me.eyeWhite,.45);m.forEach((ae,ve)=>{let Le=ve*nt,K=ae.scene===null?{grey:ae.down||ae.noBoard||ae.gone,dots:[]}:cr(ae.scene,ae.looks,ae.homeOrder,{down:ae.down,noBoard:ae.noBoard,gone:ae.gone});ot(T,0,Le,pt,nt,K.grey?ze(Ae.wall,me.eyeWhite,.15):Ae.floorA),K.dots.forEach((ie,Oe)=>{let Te=Oe%us*(mt+cs)+1,gt=Le+16+Math.floor(Oe/us)*(mt+cs),St=ie.hue===null?x:It.bodies[ie.hue]??x;ie.hollow?Gn(T,Te,gt,mt,mt,St):ot(T,Te,gt,mt,mt,St)});let he=Bt(ae.overlay);he!==null&&ot(T,pt-6,Le+2,4,4,he.down?x:he.unreadable?Ze.health[0]:Ze.tick[0]),ae.id===I&&Gn(T,0,Le,pt,nt,Ae.accent),ae.id===_&&Gn(T,1,Le+1,pt-2,nt-2,me.eyeWhite)});let W=pt*L,Y=T.h*L,F=document.createElement("canvas");qn(F,T),ee(e,T.w,T.h,L);let q=e.getContext("2d");if(q===null)return;q.imageSmoothingEnabled=!1,q.clearRect(0,0,W,Y),q.drawImage(F,0,0,W,Y);let Z=ds*X();m.forEach((ae,ve)=>{let Le=$(ae.label,Z);q.drawImage(Le,2*L,ve*nt*L+2*L)})};return w.addEventListener("change",()=>{f.clear(),Re.wake()}),{room(m){S=m,E="",C.clear(),!A&&m!==null&&(A=!0,s.open(n.clientWidth*X())),Re.wake()},show:re,toggleCoarse(){return s.toggleCoarse(),E="",Re.wake(),s.coarse},zoomBy(m){s.userZoom(m),Re.wake()},resize(){s.resize(n.clientWidth*X()),Re.wake()},motion(){if(z()){let m=performance.now();for(let I of C.values())H(I,m)&&(I.path=null)}Re.wake()},map:tn,follow(m){if(S===null||m>=S.layout.desks.length||!a.follow(performance.now()))return;let I=S.layout.desks[m];if(I.kind!=="big_table"&&(I.cell===null||I.slot===null))return;let _=we(S.layout,m).desk[0].y*16*s.z/X();_>=n.scrollTop&&_<=n.scrollTop+n.clientHeight-16||(V=!0,n.scrollTop=Math.max(0,_-n.clientHeight/2))},relabel(){Re.wake()}}}var Et=64,rt=8,Ll=2,xl=6,Tl=Object.freeze({publish:null,conflict:"bang",request:"speech",save:"star",door:"door",freeze:"snowflake"});function ps(t){switch(t.kind){case"publish":return{h:t.height,glyph:"publish"};case"conflict":return{h:t.height,glyph:"conflict"};case"request_open":return{h:t.height,glyph:"request"};case"save":return{h:t.height,glyph:"save"};case"person_enter":case"person_respawn":case"person_exit":return{h:t.height,glyph:"door"};case"person_freeze":return{h:t.height,glyph:"freeze"};default:return null}}function Dl(t,e,n){let o=Ze.tick[0];for(let r=Math.max(0,n);r<Math.min(t.h,n+xl);r++)for(let s=Math.max(0,e);s<Math.min(t.w,e+Ll);s++){let a=(r*t.w+s)*4;t.data[a]=o[0],t.data[a+1]=o[1],t.data[a+2]=o[2],t.data[a+3]=255}}function ms(t,e){let{t:n}=e,o={h0:0,h1:0,at:0,live:!0,playing:!1,speed:1,reconnecting:!1,canEarlier:!1,ticks:[],caught:[]},r="",s=_e(k.control,t,()=>e.play(!o.playing)),a=B("div",k.track,t),l=B("canvas",k.ticks,a);l.classList.add(k.pixel);let c=B("input",k.slider,a);c.type="range",c.step=String(1);let f=B("span",k.position,t),d=B("select",k.control,t);for(let p of Tt){let E=B("option",null,d);E.value=String(p),E.textContent=`${p}×`}d.value=String(1);let h=_e(k.livePill,t,()=>e.live()),w=_e(k.control,t,()=>e.earlier());c.addEventListener("input",()=>e.seek(Number(c.value))),c.addEventListener("keydown",p=>{let E=Object.hasOwn(ct,p.key)?ct[p.key]:void 0;if(E==="page_back"||E==="page_fwd"){p.preventDefault();let V=Math.min(o.h1,Math.max(o.h0,o.at+(E==="page_back"?-Et:Et)));e.seek(V)}}),d.addEventListener("change",()=>e.speed(Number(d.value))),l.addEventListener("pointermove",p=>{let E=A(p.offsetX);if(E===null){l.title="";return}let V=e.describe(E);l.title=V===null?`#${E}`:`#${E} · ${V}`});let A=p=>{let E=null;for(let V of o.ticks){let C=Math.abs(S(V.h)+rt/2-p);C<=rt/2&&(E===null||C<E.d)&&(E={h:V.h,d:C})}return E===null?null:E.h},S=p=>{let E=Math.max(rt,l.width-rt),V=Math.max(1,o.h1-o.h0);return Math.round((p-o.h0)/V*E)},g=()=>{let p=Math.max(rt,Math.floor(a.clientWidth)),E=`${p}:${o.h0}:${o.h1}:${o.ticks.length}:${o.caught.length}`;if(E===r)return;r=E,l.width=p,l.height=rt;let V=ht(p,rt);for(let z of o.ticks){let H=Tl[z.glyph];H===null?Dl(V,S(z.h)+3,1):ge(V,pe[H],Se(H),S(z.h),0)}for(let z of o.caught)ge(V,pe.caught_up,Se("caught_up"),S(z),0);let C=l.getContext("2d");if(C===null)return;let X=C.createImageData(V.w,V.h);X.data.set(V.data),C.putImageData(X,0,0)},R=()=>{s.textContent=n(o.playing?"UI_VIZ_CTRL_PAUSE":"UI_VIZ_CTRL_PLAY"),c.setAttribute("aria-label",n("UI_VIZ_CTRL_PLAY")),d.setAttribute("aria-label",n("UI_VIZ_CTRL_SPEED")),h.textContent=n("UI_VIZ_CTRL_LIVE"),w.textContent=n("UI_VIZ_CTRL_LOAD_EARLIER")};return{update(p){let E=p.ticks!==o.ticks||p.caught!==o.caught||p.h0!==o.h0||p.h1!==o.h1;o=p,E&&(r=""),c.min=String(p.h0),c.max=String(p.h1),c.value=String(p.at),c.setAttribute("aria-valuetext",`#${p.at}`),f.textContent=`#${p.at}`,d.value=String(p.speed),xe(s,p.playing),xe(h,p.live),h.classList.toggle(k.liveOn,p.live&&!p.reconnecting),h.classList.toggle(k.liveOff,p.reconnecting),w.disabled=!p.canEarlier,R(),g()},relabel:R}}var bs="UI_VIZ_CTRL_LANGUAGE",Pl=6e4,Nl=Object.freeze({booting:null,live:null,reconnecting:"UI_VIZ_RECONNECTING",stopped:"UI_VIZ_STOPPED",link_reused:"UI_VIZ_LINK_REUSED",link_expired:"UI_VIZ_LINK_EXPIRED",need_link:"UI_VIZ_NEED_LINK"});function Vl(){try{let e=localStorage.getItem(bs),n=Ue.find(o=>o===e);if(n!==void 0)return n}catch{}let t=typeof navigator=="object"?navigator.language.toLowerCase():"";return Ue.find(e=>t===e.toLowerCase()||t.startsWith(e.slice(0,2).toLowerCase()))??Ue[0]}var gs=t=>typeof t=="object"&&t!==null&&!Array.isArray(t);function Ul(t){return gs(t)&&typeof t.room_id=="string"&&typeof t.from=="number"&&typeof t.to=="number"&&gs(t.scene)&&Array.isArray(t.events)&&Array.isArray(t.cards)}function Zl(){let t=sr({hash:location.hash,clear:()=>history.replaceState(null,"","/")}),e=Ir(),n=new jt,o=Vl(),r=(i,u={})=>n.render(i,u,o),s=()=>n.has(o),a=document.getElementById("app")??document.body,l=document.documentElement,c=B("div",k.app,a),f=B("header",k.top,c),d=B("div",k.banner,f);d.hidden=!0;let h=B("span",k.lamp,f);h.hidden=!0;let w=B("span",k.status,f),A=B("div",k.status,f);A.setAttribute("role","status");let S=B("div",k.notice,f),g=B("div",k.main,c),R=B("nav",k.map,g),p=B("canvas",k.pixel,R),E=B("ul",k.rooms,R);E.classList.add(k.srOnly);let V=B("section",k.office,g),C=B("ul",k.people,V);C.classList.add(k.srOnly);let X=B("div",k.scroll,V),z=B("canvas",k.pixel,X),H=B("div",k.caption,V),Q=B("aside",k.log,g),oe=B("div",k.srOnly,c),Ie=B("footer",k.rewind,c),re=B("div",k.controls,c),D="booting",$=null,G=new Map,ee=[],te=null,fe=null,U={live:!0,at:0,playing:!1,speed:1},J=null,ue=null,se=null,Re=null,le=()=>te===null?null:G.get(te)??null,tn=()=>e.storage.get().session??"",m=()=>({method:"GET",headers:{"X-Cowork-Session":tn()}}),I=yr({root:l,canvas:z,people:C,live:oe,controls:re,t:r,onMotion:()=>_.motion(),onPerson:i=>oo(i)}),_=hs(z,p,X,{t:r,reduced:()=>I.reduced(),paused:()=>I.paused(),person:i=>oo(i),desk:i=>{L.desk(i),qe()},selectRoom:i=>no(i),highlighted:()=>L.filter().peer}),L=Er(Q,{t:r,nameOf:i=>Z(i),hueOf:i=>{let u=le(),O=u===null?null:q(i);return u===null||O===null?null:u.looks.get(O)?.hue??null},personOf:i=>q(i),deskOfPath:i=>le()?.layoutVM.desks.find(u=>u.path===i)?.ordinal??null,pathOfDesk:i=>{let u=le()?.layoutVM.desks[i];return u===void 0?null:u.path??u.plaque},changed:()=>{qe(),on()},version:()=>le()?.textVersion??0}),T=ms(Ie,{t:r,seek:i=>vt(i),play:i=>{let u=le();if(u!==null){if(i&&U.live)return vt(u.tl.h0,!0);Jn(i)}},speed:i=>{U.speed=Tt.includes(i)?i:1,Fe()},live:()=>to(),earlier:()=>{let i=le();i!==null&&i.tl.earlier()},describe:i=>{let u=le();if(u===null)return null;let O=u.log.at(i),M=O.find(v=>v.code==="UI_VIZ_CARD_PUBLISH")??O[0];return M!==void 0?ae(M):u.caught.includes(i)?r("UI_VIZ_CAUGHT_UP"):null}}),x=B("select",k.control,re);for(let i of Ue){let u=B("option",null,x);u.value=i,u.textContent=i}x.value=o,x.addEventListener("change",()=>void Le(x.value));let W=_e(k.control,re,()=>_.zoomBy(-1));W.textContent="−";let Y=_e(k.control,re,()=>_.zoomBy(1));Y.textContent="+";let F=_e(k.control,re,()=>xe(F,_.toggleCoarse()));xe(F,!1);function q(i){return"peer"in i?i.peer:le()?.owners.get(i.seat)??null}function Z(i){let u=le(),O=q(i);return O===null?"?":u?.names.get(O)??O}function ae(i){let u=Ft(i,Z);return r(u.code,u.params)}async function ve(i){if(!n.asked(i))try{let u=await e.request({r:"strings",lang:i},m());u.status===200&&n.accept(i,u.json)}catch{}}async function Le(i){let u=Ue.find(O=>O===i);if(u!==void 0){o=u;try{localStorage.setItem(bs,u)}catch{}await ve(u),K()}}function K(){W.setAttribute("aria-label",r("UI_VIZ_CTRL_ZOOM")),Y.setAttribute("aria-label",r("UI_VIZ_CTRL_ZOOM")),F.textContent=r("UI_VIZ_CTRL_COARSE"),x.setAttribute("aria-label",r("UI_VIZ_CTRL_LANGUAGE")),I.relabel(),L.relabel(),T.relabel(),_.relabel(),Ke()}function he(i,u){let O=In(i.layout),M=qt(i.scene),v={id:i.room_id,label:i.label,branch:i.branch,gone:i.gone,badges:[...i.badges],unknown:i.unknown,layoutVM:i.layout,layout:O,looks:new Map(i.looks),characters:new Map(i.characters.map(ne=>[ne.handle,ne])),pets:new Map(i.pets.map(ne=>[ne.seat,ne])),owners:new Map([...i.scene.pets.map(([ne,Ee])=>[ne,Ee.owner]),...i.pets.map(ne=>[ne.seat,ne.owner])]),names:new Map(i.characters.map(ne=>[ne.handle,ne.name])),overlay:i.overlay,tl:null,live:null,log:new Zt,textVersion:0,ticks:[...i.ticks],caught:[],captions:new Map};v.tl=new zt(i.room_id,M,i.window,O,{page:(ne,Ee)=>ys(v,ne,Ee),merged:ne=>ws(v,ne),changed:()=>As(v)}),v.live=new Ht(M,()=>v.layout),ie(v,i.cards);for(let ne of u){if(ne.room_id!==v.id)continue;let Ee=v.captions.get(ne.height)??[];Ee.push(ne),v.captions.set(ne.height,Ee)}return v}function ie(i,u){i.log.add(u,performance.now())}function Oe(i,u){(u.kind==="pet_spawn"||u.kind==="pet_poof")&&i.owners.get(u.seat)!==u.owner&&(i.owners.set(u.seat,u.owner),i.textVersion++)}function Te(i,u){i.layoutVM=u,i.layout=In(u),i.tl.setLayout(i.layout)}function gt(i,u,O){for(let M of u){let v=i.looks.get(M.handle);(i.names.get(M.handle)!==M.name||v?.hue!==M.hue||v.accessory!==M.accessory)&&i.textVersion++,i.characters.set(M.handle,M),i.names.set(M.handle,M.name),i.looks.set(M.handle,{hue:M.hue,accessory:M.accessory})}for(let M of O)i.owners.get(M.seat)!==M.owner&&i.textVersion++,i.pets.set(M.seat,M),i.owners.set(M.seat,M.owner)}function St(i){$=i;let u=te;G.clear();for(let O of i.rooms)G.set(O.room_id,he(O,i.captions));ee=i.rooms.map(O=>O.room_id),te=rr(i,u??e.storage.get().room),Rt(),J=null,U.live=!0,U.playing=!1,ve(o).then(()=>{K(),nn(!0),i.demo&&ks()}),nn(!0)}function _s(i){switch(i.type){case"timeline":{let u=G.get(i.room_id);if(u===void 0)return;gt(u,i.characters,i.pets);let O=i.events.map(Gt);for(let v of O)Oe(u,v);let M=u.tl.append(O,i.h1);for(let v of i.events)v.kind==="request_status"&&u.log.status(v);return ie(u,i.cards),u.ticks.push(...i.ticks),u.id===te&&U.live?(u.live.push(M),i.cards.length>0&&I.announce(ae(i.cards[i.cards.length-1])),$n()):u.live.reset(u.tl.head()),bt(u)}case"room_snapshot":{let u=G.get(i.room_id);if(u===void 0)return;let O=qt(i.scene);for(let[M,v]of i.scene.pets)u.owners.get(M)!==v.owner&&u.textVersion++,u.owners.set(M,v.owner);return gt(u,i.characters,i.pets),u.tl.snapshot(O,i.window),u.live.reset(O),u.ticks=[...i.ticks],u.caught=[...u.caught,i.window.h1],ie(u,i.cards),u.id===te&&(U.live?_.show(O,{live:!0,overlay:u.overlay,speed:1,animate:!1}):J===null&&!u.tl.holds(U.at)&&(J={h:U.at,play:!1},u.tl.want(U.at))),bt(u)}case"layout":{let u=G.get(i.room_id);if(u===void 0)return;let O=En(u.layoutVM,i.layout);return O!=="reload"&&Te(u,O),bt(u)}case"overlay":{let u=G.get(i.room_id);return u===void 0?void 0:(u.overlay=i.overlay,u.id===te&&U.live&&_.show(u.live.scene(),{live:!0,overlay:u.overlay,speed:1,animate:!1}),bt(u))}case"room":{let u=G.get(i.room_id);return u===void 0?void 0:(u.label=i.label,u.branch=i.branch,u.gone=i.gone,u.badges=[...i.badges],u.unknown=i.unknown,bt(u))}default:return}}function bt(i){i.id===te?Ke():sn()}function Rt(){ue!==null&&clearTimeout(ue),se!==null&&clearTimeout(se),ue=null,se=null}function Kn(i,u,O){let v=i.captions.get(u)?.[0];if(v===void 0){Re!==null&&performance.now()>=Re&&(H.textContent="",H.classList.remove(k.quote),Re=null);return}v.code!==null?(H.textContent=r(v.code),H.classList.remove(k.quote)):(H.textContent=v.text??"",H.classList.add(k.quote)),Re=performance.now()+O}function $n(){ue===null&&J===null&&(ue=window.setTimeout(()=>Wn(),0))}function Wn(){ue=null;let i=le();if(i===null||!U.live||J!==null)return;let u=i.live.beat(()=>i.tl.head());if(u===null)return;if(u.kind==="snap"){i.caught=[...i.caught,u.height],_.show(u.scene,{live:!0,overlay:i.overlay,speed:1,animate:!1}),I.scene(u.scene,[...i.characters.values()],i.layout),Ke();return}_.show(u.scene,{live:!0,overlay:i.overlay,speed:1,animate:!0});let O=u.events.find(M=>M.kind==="publish");O!==void 0&&O.kind==="publish"&&_.follow(O.target),Kn(i,u.height,xt),I.scene(u.scene,[...i.characters.values()],i.layout),Fe(),i.live.queued()>0&&(ue=window.setTimeout(()=>Wn(),xt))}function Yn(i){return U.live?i.live.scene():i.tl.sceneAt(U.at)}function Xn(i){let u=le();if(u===null)return;let O=u.tl.sceneAt(U.at);O!==null&&(_.show(O,{live:!1,overlay:null,speed:U.speed,animate:i}),Kn(u,U.at,Dt(U.speed)),I.scene(O,[...u.characters.values()],u.layout)),qe(),Fe()}function Jn(i){U.playing=i&&!U.live,se!==null&&clearTimeout(se),se=null,U.playing&&(se=window.setTimeout(()=>Qn(),Dt(U.speed))),Fe()}function Qn(){se=null;let i=le();if(!(i===null||U.live||!U.playing)){if(J===null){let u=i.tl.nextHeight(U.at);if(u===null){U.playing=!1,Fe();return}U.at=u,Xn(!0)}se=window.setTimeout(()=>Qn(),Dt(U.speed))}}function eo(i,u){ue!==null&&clearTimeout(ue),ue=null,U.live=!1,U.at=i,Xn(!1),u&&Jn(!0)}function vt(i,u=!1){let O=le();if(O===null||!Number.isSafeInteger(i))return;let M=Math.min(Math.max(i,O.tl.h0),O.tl.top());if(O.tl.holds(M)){J=null,O.tl.dropTarget(),eo(M,u);return}J={h:M,play:u},ue!==null&&clearTimeout(ue),ue=null,O.tl.want(M),Fe()}function As(i){if(i===le()){if(J!==null){let u=J;i.tl.holds(u.h)?(J=null,eo(u.h,u.play)):i.tl.loading()||(J=null,U.live&&$n())}Ke()}}function to(){let i=le();if(Rt(),J=null,U.live=!0,U.playing=!1,i===null)return Ke();i.tl.dropTarget(),i.live.reset(i.tl.head()),_.show(i.live.scene(),{live:!0,overlay:i.overlay,speed:1,animate:!1}),I.scene(i.live.scene(),[...i.characters.values()],i.layout),Ke()}async function ys(i,u,O){let M;try{M=await e.request({r:"timeline",room:i.id,from:u,to:O},m())}catch{return null}if(M.status!==200||!Ul(M.json))return null;let v=M.json;try{return{room:v.room_id,from:v.from,to:v.to,start:qt(v.scene),events:v.events.map(Gt),vm:v}}catch{return null}}function ws(i,u){let O=[];for(let M of u){if(M.vm.layout!==null){let v=En(i.layoutVM,M.vm.layout);v!=="reload"&&Te(i,v)}for(let v of M.events)Oe(i,v);for(let v of M.vm.events)v.kind==="request_status"&&i.log.status(v);ie(i,M.vm.cards),i.tl.h0>0&&M.from<=i.tl.h0&&O.push(...M.events.map(ps).filter(v=>v!==null))}O.length>0&&(i.ticks=[...O,...i.ticks])}function ks(){let i=le();i!==null&&vt(i.tl.h0,!0)}function no(i){!G.has(i)||i===te||(le()?.tl.dropTarget(),te=i,e.storage.set({room:i}),Rt(),J=null,U.live=!0,U.playing=!1,L.person(null),L.desk(null),nn(!1))}function nn(i){let u=le();_.room(u),u!==null?(u.live.reset(u.tl.head()),_.show(u.live.scene(),{live:!0,overlay:u.overlay,speed:1,animate:!1}),I.scene(u.live.scene(),[...u.characters.values()],u.layout)):I.scene(null,[],null),i&&(H.textContent=""),Ke()}function oo(i){L.person(i),qe(),on()}function on(){let i=le();if(i===null)return;let u=Yn(i);u!==null&&_.show(u,{live:U.live,overlay:U.live?i.overlay:null,speed:U.speed,animate:!1})}function qe(){let i=le();L.render(i===null?null:i.log,{replay:!U.live,nowMono:performance.now()})}function Fe(){let i=le();if(i===null)return;let u=i.tl.top(),O=J!==null?J.h:U.live?u:U.at;T.update({h0:i.tl.h0,h1:u,at:O,live:U.live,playing:U.playing,speed:U.speed,reconnecting:D==="reconnecting",canEarlier:i.tl.canEarlier(),ticks:i.ticks,caught:i.caught})}function ro(){let i=Nl[D];A.hidden=i===null,i!==null&&(A.setAttribute("data-code",i),A.textContent=n.can(i,o)?r(i):i),l.setAttribute("data-state",D),d.hidden=$===null||!$.demo,d.textContent=s()?r("UI_VIZ_DEMO_BANNER"):"";let u=le(),O=[];if($!==null&&$.rooms.length===0&&O.push(r("UI_VIZ_NO_ROOMS")),u!==null){w.textContent=u.branch===""?u.label:`${u.label} · ${u.branch}`,u.gone&&O.push(r("UI_VIZ_ROOM_GONE"));for(let Ee of u.badges)O.push(r(Ee));let M=Bt(u.overlay);h.hidden=M===null,M!==null&&(h.className=k.lamp,h.classList.add(M.down?k.lampDown:M.unreadable?k.lampWarn:k.lampOk),h.title=M.state,M.down&&O.push(r("UI_VIZ_ROOM_DOWN")),M.unreadable&&O.push(r("UI_VIZ_STATUS_UNREADABLE")));let v=u.overlay?.offline_min??null;v!==null&&O.push(r("UI_VIZ_LAST_FETCH",{n:v}));let ne=Yn(u)?.badge??"none";ne==="full"?O.push(r("UI_VIZ_BOARD_FULL")):ne==="near_full"&&O.push(r("UI_VIZ_BOARD_NEAR_FULL"))}else w.textContent="",h.hidden=!0;S.textContent=s()?O.join(" · "):""}function rn(){let i=ee.map(u=>G.get(u)).filter(u=>u!==void 0);_.map(i.map(u=>({id:u.id,label:u.label,scene:u.tl.head(),looks:u.looks,homeOrder:u.layout.homeOrder,down:u.overlay?.down??!1,noBoard:u.badges.includes("UI_VIZ_NO_BOARD"),gone:u.gone,overlay:u.overlay})),te,fe)}let so="",Ot=new Map;function sn(){rn();let u=ee.map(v=>G.get(v)).filter(v=>v!==void 0).map(v=>({id:v.id,text:v.branch===""?v.label:`${v.label} · ${v.branch}`,current:v.id===te})),O=JSON.stringify(u);if(O===so)return;so=O;let M=[...Ot].find(([,v])=>v===document.activeElement)?.[0]??null;Ot.clear(),E.replaceChildren(...u.map(v=>{let ne=B("li",null),Ee=_e(k.room,ne,()=>no(v.id));return Ee.textContent=v.text,v.current&&Ee.setAttribute("aria-current","true"),Ee.addEventListener("focus",()=>{fe=v.id,rn()}),Ee.addEventListener("blur",()=>{fe===v.id&&(fe=null),rn()}),Ot.set(v.id,Ee),ne})),M!==null&&Ot.get(M)?.focus({preventScroll:!0})}function Ke(){ro(),sn(),qe(),Fe()}document.addEventListener("keydown",i=>{let u=i.target,O=u instanceof HTMLInputElement||u instanceof HTMLSelectElement||u instanceof HTMLTextAreaElement,M=Object.hasOwn(ct,i.key)?ct[i.key]:void 0;if(M===void 0||O&&M!=="clear_filters")return;let v=le();switch(M){case"live":to();break;case"clear_filters":L.clear(),qe(),on();break;case"zoom_in":_.zoomBy(1);break;case"zoom_out":_.zoomBy(-1);break;case"step_back":case"step_fwd":case"page_back":case"page_fwd":{if(v===null)return;let ne=M==="step_back"?-1:M==="step_fwd"?1:M==="page_back"?-Et:Et,Ee=J!==null?J.h:U.live?v.tl.top():U.at;i.preventDefault(),vt(Ee+ne);break}case"select":return}}),window.addEventListener("resize",()=>{_.resize(),sn(),Fe()}),window.setInterval(()=>{U.live&&qe()},Pl);let Is=new Vt(e,{state:i=>{D=i,i!=="live"&&i!=="booting"&&i!=="reconnecting"&&Rt(),ro(),Fe()},world:i=>St(i),payload:i=>_s(i)});K(),Is.start(t)}Zl();})();\n';

// viz-asset:app.css
var app_default2 = `/* The page's chrome (12-visualizer §3.6 "Environment palette", §3.7 "Rendering", §3.8 "Panel", §3.11 "Accessibility"), served as
   /app.css from dist/viz.js. One light and one dark token set (prefers-color-scheme); every text colour is a --fg token and every
   --fg token reads at >= 4.5:1 on every --bg token of its theme; the apricot accent (#D97757, both themes) marks the selected
   room, the live pill, the rewind progress and the focus ring, and is never a text colour. The scene keeps its own palette in both
   themes (the canvases). Every class here is a value of the page's enum map (client/a11y.ts CLS), and that map names no other. */

:root {
  color-scheme: light;
  --bg: #F4F2EE;
  --bg-panel: #FFFFFF;
  --bg-quote: #ECE8E2;
  --bg-chip: #E7E3DD;
  --fg: #1C1B22;
  --fg-muted: #4A4754;
  --accent: #D97757;
  --border: #BDB7C2;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #141319;
    --bg-panel: #1C1B23;
    --bg-quote: #2A2833;
    --bg-chip: #302E3A;
    --fg: #EEECF3;
    --fg-muted: #B7B3C2;
    --accent: #D97757;
    --border: #4A4756;
  }
}

html, body {
  margin: 0;
  height: 100%;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.4 system-ui, sans-serif;
}

/* Layout: header; the map, the office and the 340 px log side by side; the rewind bar and the controls below. */
.app {
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  height: 100vh;
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 6px 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.banner {
  padding: 2px 8px;
  border: 2px solid var(--accent);
  border-radius: 4px;
  font-weight: 600;
  color: var(--fg);
}
.status {
  font-weight: 600;
  color: var(--fg);
}
.notice {
  color: var(--fg-muted);
}
.lamp {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-chip);
}
.lamp-ok { background: #5CC86A; }
.lamp-warn { background: #F2C14E; }
.lamp-down { background: #9AA0AE; }

.main {
  display: grid;
  grid-template-columns: auto 1fr 340px;
  min-height: 0;
}
.map {
  overflow-y: auto;
  padding: 8px;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
}
.rooms {
  list-style: none;
  margin: 0;
  padding: 0;
}
.room {
  font: inherit;
  color: var(--fg);
  background: var(--bg-panel);
  border: 1px solid var(--border);
}
.office {
  display: grid;
  grid-template-rows: 1fr auto;
  min-width: 0;
  min-height: 0;
  background: #22222C;
}
.scroll {
  overflow: auto;
  min-height: 0;
}
.caption {
  min-height: 1.4em;
  padding: 4px 12px;
  background: var(--bg-panel);
  color: var(--fg);
  border-top: 1px solid var(--border);
}

/* Every canvas: integer art pixels, never smoothed (12 §3.7). */
.pixel {
  display: block;
  image-rendering: pixelated;
}

/* The log (12 §3.8): DOM, so text is selectable and read by screen readers. */
.log {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.filter {
  font: inherit;
  padding: 2px 8px;
  color: var(--fg);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.filter[aria-pressed="true"] {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.cards {
  position: relative;
  overflow-y: auto;
  margin: 0;
  padding: 6px 8px 32px;
  list-style: none;
}
.card {
  margin: 0 0 6px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.card-system {
  color: var(--fg-muted);
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.hue-0 { background: #d97757; }
.hue-1 { background: #e69f00; }
.hue-2 { background: #56b4e9; }
.hue-3 { background: #009e73; }
.hue-4 { background: #f0e442; }
.hue-5 { background: #0072b2; }
.hue-6 { background: #cf7caa; }
.name {
  font: inherit;
  font-weight: 600;
  padding: 0;
  color: var(--fg);
  background: none;
  border: 0;
  cursor: pointer;
}
.text {
  margin: 2px 0;
}
/* Teammate free text: a visually distinct quoted frame, never styled as the viewer's own text (VIZ-25). */
.quote {
  margin: 4px 0;
  padding: 4px 8px;
  font-style: italic;
  color: var(--fg);
  background: var(--bg-quote);
  border-left: 3px solid var(--border);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  font: 12px/1.4 ui-monospace, monospace;
  padding: 0 6px;
  color: var(--fg);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.meta {
  font-size: 12px;
  color: var(--fg-muted);
}
.answers {
  list-style: none;
  margin: 4px 0 0 12px;
  padding: 0;
}
.new-pill {
  position: sticky;
  bottom: 4px;
  left: 50%;
  font: inherit;
  padding: 2px 12px;
  color: var(--fg);
  background: var(--bg-panel);
  border: 2px solid var(--accent);
  border-radius: 12px;
}

/* The rewind bar and the controls (12 §3.9.1, §3.11): reachable by Tab after the log. */
.rewind,
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
}
.track {
  flex: 1 1 320px;
  min-width: 200px;
}
.ticks {
  width: 100%;
  height: 8px;
}
.slider {
  width: 100%;
  margin: 0;
  accent-color: var(--accent);
}
.position {
  min-width: 5em;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.control {
  font: inherit;
  padding: 2px 10px;
  color: var(--fg);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.control[aria-pressed="true"] {
  border-color: var(--accent);
}
.live-pill {
  font: inherit;
  padding: 2px 12px;
  color: var(--fg);
  background: var(--bg-chip);
  border: 2px solid var(--border);
  border-radius: 12px;
}
.live-on {
  border-color: var(--accent);
}
/* Reconnecting: muted text and a dashed border, never an opacity (a composite would draw the text below 4.5:1, VIZ-40). */
.live-off {
  color: var(--fg-muted);
  border-style: dashed;
}

/* Visually hidden, still read by screen readers; shown while one of its buttons has focus (focus is always visible). */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.people:focus-within,
.rooms:focus-within {
  position: static;
  width: auto;
  height: auto;
  clip-path: none;
  white-space: normal;
}
.people {
  list-style: none;
  margin: 0;
  padding: 0;
}
.person {
  font: inherit;
  color: var(--fg);
  background: var(--bg-panel);
  border: 1px solid var(--border);
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Reduced motion (12 §3.11): the page's own toggle or the OS setting; nothing in the chrome moves. */
[data-motion="reduced"] * {
  transition: none;
  animation: none;
  scroll-behavior: auto;
}

/* Below 1,100 px the log is a drawer under the office (12 §3.8). */
@media (max-width: 1099px) {
  .main {
    grid-template-columns: auto 1fr;
    grid-template-rows: 1fr minmax(160px, 38vh);
  }
  .log {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--border);
  }
}
`;

// viz-asset:demo.jsonl
var demo_default = '{"t":"header","format":"cowork-viz-demo/1","rooms":[{"room":"a","name":"shop-app","branch":"main"}]}\n{"t":"commit","room":"a","height":0,"writer":"6b1f0c2e9d4a7f3851c0e6a2d9b47f13/0d3e8a51f2c94b76e01a5c3d8f2b9e47/3","protocol":{"proto":1,"regionSpec":"rs-1","budget":12,"G_s":5,"S_s":1.5},"code":{"changed":false,"seats":[],"base":null},"cs":[],"csPaths":{},"ops":["{\\"coauthor_optin\\":false,\\"config_fingerprint\\":{\\"autocrlf\\":\\"\\",\\"eol_attrs\\":\\"\\",\\"filters\\":{},\\"git\\":\\"2.43.0\\"},\\"display\\":\\"Ann\\",\\"id\\":\\"6b1f0c2e9d4a7f3851c0e6a2d9b47f13/0d3e8a51f2c94b76e01a5c3d8f2b9e47/1\\",\\"plugin_sha\\":\\"0000000000000000000000000000000000000000000000000000000000000000\\",\\"plugin_version\\":\\"0.0.0\\",\\"proto\\":1,\\"regionSpec\\":\\"rs-1\\",\\"type\\":\\"join\\"}","{\\"custom_refs\\":true,\\"delete\\":true,\\"id\\":\\"6b1f0c2e9d4a7f3851c0e6a2d9b47f13/0d3e8a51f2c94b76e01a5c3d8f2b9e47/2\\",\\"lease\\":true,\\"push_options\\":false,\\"two_parent_ok\\":true,\\"type\\":\\"caps\\"}"]}\n';

// src/viz/assets.ts
var VIZ_ASSETS = Object.freeze({ appJs: app_default, appCss: app_default2, bundledDemo: demo_default });

// src/viz/main.ts
import { createHash as createHash7 } from "node:crypto";
import { posix as posix5, win32 as win327 } from "node:path";
import { fileURLToPath } from "node:url";

// src/git/version.ts
var GIT_FLOOR = Object.freeze({ major: 2, minor: 43, patch: 0, raw: "2.43.0" });
var PREFIX = "git version ";
var NUMBERS = /^(\d+)\.(\d+)(?:\.(\d+))?/;
function parseGitVersion(stdout) {
  const firstLine = (stdout.replace(/^\uFEFF/, "").trimStart().split(/\r?\n/)[0] ?? "").trim();
  if (!firstLine.startsWith(PREFIX)) {
    throw new Error(`parseGitVersion: unexpected output ${JSON.stringify(firstLine.slice(0, 80))}`);
  }
  const raw = firstLine.slice(PREFIX.length).trim();
  const m = NUMBERS.exec(raw);
  if (m === null || m[1] === void 0 || m[2] === void 0) {
    throw new Error(`parseGitVersion: no version number in ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === void 0 ? 0 : Number(m[3]),
    raw
  };
}
function meetsFloor(v) {
  if (v.major !== GIT_FLOOR.major) return v.major > GIT_FLOOR.major;
  if (v.minor !== GIT_FLOOR.minor) return v.minor > GIT_FLOOR.minor;
  return v.patch >= GIT_FLOOR.patch;
}

// src/text/sanitize.ts
var LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
var LINE_BREAK = /\r\n|[\r\n\u{85}\u{2028}\u{2029}]/gu;
var STRIPPED = /(?!\n)[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}]/gu;
var ESCAPE_INTRODUCER = /[\u{1B}\u{90}\u{98}\u{9B}\u{9D}\u{9E}\u{9F}]/u;
var COMMAND_TOKENS = /^(?:\s*\/\S*)+\s*/u;
var BARE_SCHEMES = "javascript|vbscript|data|blob|file|mailto";
var URL_BARE = new RegExp(String.raw`(?<![A-Za-z0-9])(?:${BARE_SCHEMES}):\S*`, "giu");
var URL_SCHEME = /(?<![A-Za-z0-9+.-])[A-Za-z0-9+.-]*:\/\/\S*/gu;
var DASH_RUN = /[-\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]{3,}/gu;
var LINK_REMOVED = "[link removed]";
var FULLWIDTH_LT = "＜";
var FULLWIDTH_GT = "＞";
var EM_DASH = "—";
var ESC = 27;
var BEL = 7;
var C1_ST = 156;
function skipCsi(s, j) {
  while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 63) j++;
  while (j < s.length && s.charCodeAt(j) >= 32 && s.charCodeAt(j) <= 47) j++;
  if (j < s.length && s.charCodeAt(j) >= 64 && s.charCodeAt(j) <= 126) j++;
  return j;
}
function skipString(s, j) {
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === BEL || c === C1_ST) return j + 1;
    if (c === ESC) return s.charCodeAt(j + 1) === 92 ? j + 2 : j;
    j++;
  }
  return j;
}
function stripEscapes(s) {
  if (!ESCAPE_INTRODUCER.test(s)) return s;
  const parts = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let next = -1;
    if (c === ESC) {
      const d = s.charCodeAt(i + 1);
      if (d === 91) next = skipCsi(s, i + 2);
      else if (d === 93 || d === 80 || d === 88 || d === 94 || d === 95) next = skipString(s, i + 2);
      else {
        let j = i + 1;
        while (j < s.length && s.charCodeAt(j) >= 32 && s.charCodeAt(j) <= 47) j++;
        next = j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 126 ? j + 1 : i + 1;
      }
    } else if (c === 155) next = skipCsi(s, i + 1);
    else if (c === 157 || c === 144 || c === 152 || c === 158 || c === 159) next = skipString(s, i + 1);
    if (next < 0) {
      i++;
      continue;
    }
    parts.push(s.slice(start, i));
    i = next;
    start = next;
  }
  parts.push(s.slice(start));
  return parts.join("");
}
function sanitize(text, channel) {
  let s = stripEscapes(text.replace(LONE_SURROGATE, ""));
  s = s.replace(LINE_BREAK, "\n").replace(STRIPPED, "").normalize("NFC");
  const sep = channel === "claude" ? "\n" : channel === "notification" || channel === "viz" ? " " : "";
  s = s.split("\n").map((line) => line.replace(COMMAND_TOKENS, "")).join(sep);
  s = s.normalize("NFC");
  s = s.replace(/</g, FULLWIDTH_LT).replace(/>/g, FULLWIDTH_GT);
  s = s.replace(URL_BARE, LINK_REMOVED).replace(URL_SCHEME, LINK_REMOVED);
  if (channel === "notification" || channel === "viz") s = s.replace(DASH_RUN, EM_DASH);
  return s;
}
var VIZ_CAPS = Object.freeze({
  name: 20,
  label: 80,
  path: 80,
  note: 280,
  branch: 80,
  room: 40,
  card: 400,
  tooltip: 200,
  plaque: 16,
  caption: 120,
  version: 20
});
var NAME_RAW_MAX = 64;
var VIZ_RAW_UNITS = Object.freeze(
  Object.fromEntries(Object.keys(VIZ_CAPS).map((k) => [k, k === "name" ? NAME_RAW_MAX : 4 * VIZ_CAPS[k]]))
);
var MARKS_PER_GRAPHEME_MAX = 4;
var MIDDLE = /* @__PURE__ */ new Set(["path", "plaque", "label"]);
var BARE_SCHEME_START = new RegExp(String.raw`^(?:${BARE_SCHEMES}):`, "iu");
var ELLIPSIS = "…";
var SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
var MARK = new RegExp("\\p{M}", "u");
function trimMarksOnce(text) {
  let changed = false;
  const parts = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    if (segment.length <= MARKS_PER_GRAPHEME_MAX) {
      parts.push(segment);
      continue;
    }
    let marks = 0;
    let kept = "";
    for (const cp of segment) {
      if (MARK.test(cp) && ++marks > MARKS_PER_GRAPHEME_MAX) {
        changed = true;
        continue;
      }
      kept += cp;
    }
    parts.push(kept);
  }
  return changed ? parts.join("") : null;
}
function trimMarks(text) {
  if (!MARK.test(text)) return text;
  let t = text;
  for (let next = trimMarksOnce(t); next !== null; next = trimMarksOnce(t)) t = next;
  return t;
}
function fit(gs, from, step2, maxG, maxU) {
  let n = 0;
  let units = 0;
  for (let i = from; i >= 0 && i < gs.length && n < maxG; i += step2) {
    const len = gs[i].length;
    if (units + len > maxU) break;
    units += len;
    n += 1;
  }
  return { n, units };
}
function cap(text, kind) {
  const maxG = VIZ_CAPS[kind];
  const maxU = VIZ_RAW_UNITS[kind];
  const t = trimMarks(text);
  if (t.length <= maxG) return t;
  const gs = Array.from(SEGMENTER.segment(t), (x) => x.segment);
  if (gs.length <= maxG && t.length <= maxU) return t;
  const contentG = maxG - 1;
  const contentU = maxU - 1;
  if (!MIDDLE.has(kind)) return gs.slice(0, fit(gs, 0, 1, contentG, contentU).n).join("") + ELLIPSIS;
  const front = fit(gs, 0, 1, Math.floor(contentG / 2), Math.floor(contentU / 2));
  const back = fit(gs, gs.length - 1, -1, contentG - front.n, contentU - front.units);
  let from = gs.length - back.n;
  while (from < gs.length && BARE_SCHEME_START.test(gs.slice(from).join(""))) from += 1;
  return gs.slice(0, front.n).join("") + ELLIPSIS + gs.slice(from).join("");
}

// src/i18n/render.ts
var LANGS = Object.freeze(["en", "ko", "zh-CN", "ja", "fr", "es"]);
var CHANNEL_CAPS = Object.freeze({
  terminal: null,
  slash: 4e3,
  systemMessage: 1050,
  notification: 120,
  json: null,
  log: null,
  viz: 400
});
var PARAM_TYPES = /* @__PURE__ */ new Set(["name", "path", "label", "id", "n", "dur", "cmd", "reason", "note", "code", "text", "url"]);
var CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
var NOT_A_REASON = ["UI_", "RF_", "SEC_", "VIZ_", "PH_", "SS_", "START_"];
var SEGMENTER2 = new Intl.Segmenter("en", { granularity: "grapheme" });
var registry = /* @__PURE__ */ new Map();
var reasonRegistry = /* @__PURE__ */ new Set();
var own = (o, key) => Object.prototype.hasOwnProperty.call(o, key) ? o[key] : void 0;
function validEntry(e) {
  if (typeof e !== "object" || e === null || typeof e.text !== "string") return false;
  const entry = e;
  if (entry.params !== void 0 && (typeof entry.params !== "object" || entry.params === null || !Object.values(entry.params).every((t) => typeof t === "string" && PARAM_TYPES.has(t)))) return false;
  if (entry.plural !== void 0 && typeof entry.plural !== "string") return false;
  if (entry.forms !== void 0 && (typeof entry.forms !== "object" || entry.forms === null || !Object.values(entry.forms).every((f) => typeof f === "string"))) return false;
  return true;
}
function entryKey(e) {
  const sortedPairs = (o) => o === void 0 ? null : Object.entries(o).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify([e.text, sortedPairs(e.params), e.plural ?? null, sortedPairs(e.forms)]);
}
function copyEntry(e) {
  const c = { text: e.text };
  if (e.params !== void 0) c.params = Object.freeze({ ...e.params });
  if (e.plural !== void 0) c.plural = e.plural;
  if (e.forms !== void 0) c.forms = Object.freeze({ ...e.forms });
  return Object.freeze(c);
}
function registerCatalog(lang, entries) {
  if (!LANGS.includes(lang)) throw new Error(`registerCatalog: unknown language ${String(lang)}`);
  const current = registry.get(lang) ?? /* @__PURE__ */ new Map();
  const add2 = /* @__PURE__ */ new Map();
  for (const code of Object.keys(entries)) {
    const e = own(entries, code);
    if (!CODE_RE.test(code) || !validEntry(e)) throw new Error(`registerCatalog: ${lang} ${code} is not a code with a catalog entry`);
    const prev = current.get(code) ?? add2.get(code);
    if (prev !== void 0 && entryKey(prev) !== entryKey(e)) throw new Error(`registerCatalog: ${lang} ${code} is already registered with another entry`);
    if (prev === void 0) add2.set(code, copyEntry(e));
  }
  for (const [code, e] of add2) current.set(code, e);
  registry.set(lang, current);
}
function registerReasonCodes(codes) {
  const list = [...codes];
  for (const code of list) {
    if (typeof code !== "string" || !CODE_RE.test(code) || NOT_A_REASON.some((p) => code.startsWith(p))) {
      throw new Error(`registerReasonCodes: ${String(code)} cannot be a reason code`);
    }
  }
  for (const code of list) reasonRegistry.add(code);
}

// src/ports/clock.ts
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
var realClock = {
  monoMs: () => performance.now(),
  wallMs: () => Date.now(),
  sleep: async (ms) => {
    await delay(Math.max(0, ms));
  }
};
function machineMonoMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1e3;
}
function anchorNow(clock) {
  return Object.freeze({ mono: clock.monoMs(), wall: clock.wallMs() });
}
function elapsedMono(clock, a) {
  return Math.max(0, clock.monoMs() - a.mono);
}
function ownStaleness(clock, a) {
  return Math.max(clock.wallMs() - a.wall, elapsedMono(clock, a));
}

// src/ports/fs.ts
import { lstatSync, promises as fsp, readFileSync, realpathSync } from "node:fs";
function hasCode(e, code) {
  return typeof e === "object" && e !== null && e.code === code;
}
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
var realFs = {
  // One open + whole-file read + close. On Windows libuv opens with share-all
  // (read|write|delete), so an editor's save is never blocked by a held handle
  // beyond this single call (glossary §26.1 W1, W3).
  async readFile(p) {
    return fsp.readFile(p);
  },
  async writeFile(p, data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.writeFile(p, data);
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async link(existing, newPath) {
    await fsp.link(existing, newPath);
  },
  async unlink(p) {
    await fsp.unlink(p);
  },
  async stat(p) {
    try {
      const s = await fsp.stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (e) {
      if (hasCode(e, "ENOENT")) return null;
      throw e;
    }
  },
  async mkdirp(p, mode) {
    await fsp.mkdir(p, mode === void 0 ? { recursive: true } : { recursive: true, mode });
  },
  async lstat(p) {
    try {
      const s = await fsp.lstat(p, { bigint: true });
      return {
        size: Number(s.size),
        mtimeNs: s.mtimeNs,
        ino: s.ino,
        dev: s.dev,
        mode: Number(s.mode),
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink()
      };
    } catch (e) {
      if (hasCode(e, "ENOENT") || hasCode(e, "ENOTDIR")) return null;
      throw e;
    }
  },
  async writeFileExclusive(p, data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFileExclusive requires a Buffer (got ${typeof data}) for ${p}`);
    }
    const h = await fsp.open(p, "wx");
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
  },
  async rmdir(p) {
    await fsp.rmdir(p);
  },
  async appendFile(p, data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.appendFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.appendFile(p, data);
  },
  async realpath(p) {
    return fsp.realpath(p);
  },
  async freeBytes(dir) {
    try {
      const s = await fsp.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      if (typeof e === "object" && e !== null && e.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        return null;
      }
      throw e;
    }
  },
  async chmod(p, mode) {
    await fsp.chmod(p, mode);
  },
  async readdir(p) {
    const names = await fsp.readdir(p);
    return names.sort(byCodeUnit);
  },
  async rmrf(p) {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
  }
};
var realRootProbe = {
  realpathNative: (p) => realpathSync.native(p),
  exists: (p) => {
    try {
      return lstatSync(p, { throwIfNoEntry: false }) !== void 0;
    } catch {
      return false;
    }
  },
  readText: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  isDir: (p) => {
    try {
      return lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
      return false;
    }
  }
};

// src/ports/random.ts
import { createHash, randomBytes } from "node:crypto";
function checkCount(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Random.bytes: n must be an integer >= 0, got ${n}`);
}
var realRandom = {
  bytes(n) {
    checkCount(n);
    return new Uint8Array(randomBytes(n));
  }
};
function randomHex(r, nBytes) {
  return Buffer.from(r.bytes(nBytes)).toString("hex");
}
var ULID_TIME_MAX = 2 ** 48 - 1;

// src/data/pluginDataDir.ts
import { posix, win32 } from "node:path";
var pathOf = (platform) => platform === "win32" ? win32 : posix;
function withoutTrailingSeparator(p, platform) {
  const min = platform === "win32" && /^[A-Za-z]:[\\/]/.test(p) ? 3 : 1;
  let end = p.length;
  while (end > min && (p[end - 1] === "/" || platform === "win32" && p[end - 1] === "\\")) end -= 1;
  return p.slice(0, end);
}

// src/sec/sddl.ts
var BUILTIN_ADMINISTRATORS = "S-1-5-32-544";
var LOCAL_SYSTEM = "S-1-5-18";
var ALLOWED_SYSTEM_SIDS = [LOCAL_SYSTEM, BUILTIN_ADMINISTRATORS];
var SID_RE = /^S-1-[0-9]+(?:-[0-9]+)+$/;
var ALIAS_RE = /^[A-Z]{2}$/;
var ALIASES = {
  SY: LOCAL_SYSTEM,
  BA: BUILTIN_ADMINISTRATORS,
  WD: "S-1-1-0",
  AU: "S-1-5-11",
  BU: "S-1-5-32-545",
  BG: "S-1-5-32-546",
  IU: "S-1-5-4",
  NU: "S-1-5-2",
  AN: "S-1-5-7",
  LS: "S-1-5-19",
  NS: "S-1-5-20",
  CO: "S-1-3-0",
  CG: "S-1-3-1",
  OW: "S-1-3-4"
};
var CREATOR_OWNER = "S-1-3-0";
var OWNER_RIGHTS = "S-1-3-4";
var ACE_FLAG_RE = /^(?:CI|OI|NP|IO|ID|SA|FA|TP|CR)*$/;
var RIGHTS_RE = /^(?:0[xX][0-9A-Fa-f]+|[0-9]+|(?:[A-Z]{2})+)$/;
var SID_TOKEN_RE = /^(?:S-1-[0-9]+(?:-[0-9]+)+|[A-Z]{2})/;
var ACL_FLAGS_RE = /^(?:NO_ACCESS_CONTROL|AI|AR|P)*/;
function sidOf(token) {
  if (SID_RE.test(token)) return token;
  if (ALIAS_RE.test(token)) return ALIASES[token] ?? token;
  return null;
}
function sections(sddl) {
  const out = {};
  const seen = /* @__PURE__ */ new Set();
  let i = 0;
  while (i < sddl.length) {
    const tag = sddl[i];
    if (!"OGDS".includes(tag) || sddl[i + 1] !== ":" || seen.has(tag)) return null;
    seen.add(tag);
    i += 2;
    if (tag === "O" || tag === "G") {
      const m = SID_TOKEN_RE.exec(sddl.slice(i));
      if (m === null) return null;
      if (tag === "O") out.owner = m[0];
      else out.group = m[0];
      i += m[0].length;
      continue;
    }
    const flags = ACL_FLAGS_RE.exec(sddl.slice(i))[0];
    i += flags.length;
    const aces = [];
    while (sddl[i] === "(") {
      let depth = 0;
      let j = i;
      for (; j < sddl.length; j += 1) {
        if (sddl[j] === "(") depth += 1;
        else if (sddl[j] === ")" && --depth === 0) break;
      }
      if (j >= sddl.length) return null;
      aces.push(sddl.slice(i + 1, j));
      i = j + 1;
    }
    if (tag === "D") out.dacl = { flags, aces };
    else out.sacl = { flags, aces };
  }
  return out;
}
function parseSddlAces(sddl) {
  const s = sections(sddl);
  if (s === null || s.dacl === void 0 || s.dacl.flags.includes("NO_ACCESS_CONTROL")) return null;
  const owner = s.owner === void 0 ? null : sidOf(s.owner);
  if (s.group !== void 0 && sidOf(s.group) === null) return null;
  const aces = s.dacl.aces;
  const allow = [];
  const allowInherited = [];
  const deny = [];
  for (const ace of aces) {
    const f = ace.split(";");
    if (f.length !== 6) return null;
    const [type, aceFlags, rights, objectGuid, inheritGuid, sidToken] = f;
    if (type !== "A" && type !== "D") return null;
    if (!ACE_FLAG_RE.test(aceFlags) || aceFlags.length % 2 !== 0 || !RIGHTS_RE.test(rights) || objectGuid !== "" || inheritGuid !== "") return null;
    const sid = sidOf(sidToken);
    if (sid === null) return null;
    if (type === "D") {
      deny.push(sid);
      continue;
    }
    const flags = aceFlags.match(/../g) ?? [];
    const inheritOnly = flags.includes("IO");
    allow.push(inheritOnly && sid === CREATOR_OWNER ? "CO" : inheritOnly && sid === OWNER_RIGHTS ? "OW" : sid);
    allowInherited.push(flags.includes("ID"));
  }
  return { owner, allow, deny, allowInherited };
}
function asUser(sid, user) {
  const rid = user.slice(user.lastIndexOf("-") + 1);
  return sid === "LA" && rid === "500" || sid === "LG" && rid === "501" ? user : sid;
}
function ownerOk(owner, user) {
  const o = asUser(owner, user);
  return o === user || o === BUILTIN_ADMINISTRATORS;
}
var admittedSids = (user) => /* @__PURE__ */ new Set([user, ...ALLOWED_SYSTEM_SIDS, "CO", "OW"]);
function sddlUserOnly(s, userSid2) {
  const user = userSid2.toUpperCase();
  if (!ownerOk(s.owner, user)) return false;
  const allow = s.allow.map((sid) => asUser(sid, user));
  if (!allow.includes(user)) return false;
  const admitted = admittedSids(user);
  return allow.every((sid) => sid !== null && admitted.has(sid));
}

// src/viz/cli/dataDir.ts
var refuse = (why) => ({ ok: false, why });
async function verifyDataDir(dirName, o) {
  try {
    const dir = withoutTrailingSeparator(dirName, o.platform);
    let st = await o.fs.lstat(dir);
    let created = false;
    if (st === null) {
      if (!o.create) return refuse("not_dir");
      await o.fs.mkdirp(dir, 448);
      st = await o.fs.lstat(dir);
      if (st === null) return refuse("probe_failed");
      created = true;
    }
    if (st.isSymbolicLink) return refuse("symlink");
    if (!st.isDirectory) return refuse("not_dir");
    if (o.platform === "win32") {
      const first = st;
      const protectDir = o.create ? o.probe.protectDir?.bind(o.probe) : void 0;
      const guarded = async (run) => {
        const before = await changedSince(o.fs, dir, first);
        if (before !== null) return before;
        await run(dir);
        return changedSince(o.fs, dir, first);
      };
      if (created && protectDir !== void 0) {
        const moved = await guarded(protectDir);
        if (moved !== null) return moved;
      }
      let r = await windowsVerdict(dir, o.probe);
      if (r.repairable && protectDir !== void 0) {
        if (!await onlyViewerFiles(o.fs, dir, o.platform)) return r.verdict;
        const moved = await guarded(protectDir);
        if (moved !== null) return moved;
        if (!await onlyViewerFiles(o.fs, dir, o.platform)) return r.verdict;
        r = await windowsVerdict(dir, o.probe);
      }
      if (!r.verdict.ok) return r.verdict;
      return await changedSince(o.fs, dir, first) ?? r.verdict;
    }
    const p = await o.probe.posix(dir);
    if (p === null) return refuse("probe_failed");
    if (p.isSymlink) return refuse("symlink");
    if (!p.isDir) return refuse("not_dir");
    const euid = o.probe.euid();
    if (euid === null) return refuse("probe_failed");
    if (p.uid !== euid) return refuse("owner");
    return (p.mode & 63) === 0 ? { ok: true } : refuse("mode");
  } catch {
    return refuse("probe_failed");
  }
}
async function changedSince(fs, dir, first) {
  const now = await fs.lstat(dir);
  if (now === null) return refuse("not_dir");
  if (now.isSymbolicLink) return refuse("symlink");
  if (!now.isDirectory) return refuse("not_dir");
  return now.dev === first.dev && now.ino === first.ino ? null : refuse("probe_failed");
}
var LOG_DIR = "log";
var PROBE_RECORD = "probe.json";
var isJsonl = (name) => name.endsWith(".jsonl");
async function onlyViewerFiles(fs, dir, platform) {
  const P = pathOf(platform);
  const regularFile = async (p) => {
    const s = await fs.lstat(p);
    return s !== null && s.isFile && !s.isSymbolicLink;
  };
  for (const name of await fs.readdir(dir)) {
    const p = P.join(dir, name);
    if (name === LOG_DIR) {
      const s = await fs.lstat(p);
      if (s === null || s.isSymbolicLink || !s.isDirectory) return false;
      for (const inner of await fs.readdir(p)) {
        if (!isJsonl(inner) || !await regularFile(P.join(p, inner))) return false;
      }
      continue;
    }
    if (!(isJsonl(name) || name === PROBE_RECORD) || !await regularFile(p)) return false;
  }
  return true;
}
async function windowsVerdict(dir, probe) {
  const fail2 = (why, repairable = false) => ({ verdict: refuse(why), repairable });
  const acl = await probe.windows(dir);
  if (acl === null) return fail2("probe_failed");
  const s = parseSddlAces(acl.sddl);
  if (s === null) return fail2("acl");
  const user = acl.userSid.toUpperCase();
  if (!ownerOk(s.owner, user)) return fail2("owner");
  if (sddlUserOnly(s, user)) return { verdict: { ok: true }, repairable: false };
  const admitted = admittedSids(user);
  const explicitAdmitted = s.allow.every((sid, i) => s.allowInherited[i] === true || admitted.has(asUser(sid, user) ?? ""));
  return fail2("acl", explicitAdmitted && s.allowInherited.includes(true));
}

// src/viz/cli/ownerProbe.ts
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 as win322 } from "node:path";

// src/viz/cli/paths.ts
var SEPARATORS = "\\/";
function isUncOrDevice(p) {
  if (p.length >= 2 && SEPARATORS.includes(p[0]) && SEPARATORS.includes(p[1])) return true;
  return p === "/dev" || p.startsWith("/dev/");
}

// src/viz/cli/ownerProbe.ts
var RUN_TIMEOUT_MS = 1e4;
var RUN_MAX_BYTES = 64 * 1024;
var SID = "S-1-[0-9]+(?:-[0-9]+)+";
var WHOAMI_LINE_RE = new RegExp(`^"[^"]*","(${SID})"\\r?\\n?$`);
var WINDOWS_ACL_COMMAND = "$ErrorActionPreference = 'Stop'; $a = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:COWORK_ACL_PATH; Microsoft.PowerShell.Utility\\Write-Output $a.Sddl";
function systemRoot() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "SYSTEMROOT");
  const v = key === void 0 ? void 0 : process.env[key];
  return v !== void 0 && /^[A-Za-z]:[\\/]/.test(v) && !isUncOrDevice(v) ? v : null;
}
function runSystem32(root, exe, args, extra = {}) {
  const system32 = win322.join(root, "System32");
  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    let size2 = 0;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(win322.join(system32, ...exe), [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        cwd: system32,
        env: { SystemRoot: root, ...extra }
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, RUN_TIMEOUT_MS);
    child.on("error", () => done(null));
    child.stdout?.on("data", (d) => {
      size2 += d.length;
      if (size2 > RUN_MAX_BYTES) {
        child.kill();
        done(null);
        return;
      }
      chunks.push(d);
    });
    child.on("close", (code) => done({ code, out: Buffer.concat(chunks).toString("utf8") }));
  });
}
async function userSid(root) {
  const r = await runSystem32(root, ["whoami.exe"], ["/user", "/fo", "csv", "/nh"]);
  if (r === null || r.code !== 0) return null;
  return WHOAMI_LINE_RE.exec(r.out)?.[1] ?? null;
}
async function windowsAcl(dir) {
  const root = systemRoot();
  if (root === null) return null;
  const [sid, acl] = await Promise.all([
    userSid(root),
    runSystem32(root, ["WindowsPowerShell", "v1.0", "powershell.exe"], ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_COMMAND], { COWORK_ACL_PATH: dir })
  ]);
  if (sid === null || acl === null || acl.code !== 0) return null;
  const lines = acl.out.split(/\r?\n/).filter((l) => l !== "");
  return lines.length === 1 && lines[0].trim() === lines[0] ? { sddl: lines[0], userSid: sid } : null;
}
async function windowsProtect(dir) {
  const root = systemRoot();
  if (root === null || !/^[A-Za-z]:[\\/]/.test(dir) || isUncOrDevice(dir)) return false;
  const sid = await userSid(root);
  if (sid === null) return false;
  const r = await runSystem32(root, ["icacls.exe"], [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "/L"
  ]);
  return r !== null && r.code === 0;
}
var realOwnerProbe = {
  async posix(path2) {
    try {
      const s = await lstat(path2);
      return { uid: s.uid, mode: s.mode, isDir: s.isDirectory(), isSymlink: s.isSymbolicLink() };
    } catch {
      return null;
    }
  },
  euid: () => typeof process.geteuid === "function" ? process.geteuid() : null,
  windows: windowsAcl,
  protectDir: windowsProtect
};

// src/viz/i18n/codes.ts
var DEMO_CAPTION_CODES = Object.freeze([
  "UI_VIZ_DEMO_CAPTION_1",
  "UI_VIZ_DEMO_CAPTION_2",
  "UI_VIZ_DEMO_CAPTION_3",
  "UI_VIZ_DEMO_CAPTION_4",
  "UI_VIZ_DEMO_CAPTION_5"
]);
var PH = [
  "PH_OK",
  "PH_OFFLINE",
  "PH_PAUSED",
  "PH_FROZEN",
  "PH_NOT_COORDINATED",
  "PH_PRESUMED_ABSENT",
  "PH_LEFT",
  "PH_SLOWED"
];
var SS = ["SS_FULL", "SS_HOOK_ONLY", "SS_NO_MCP", "SS_NO_HOOKS", "SS_DEGRADED", "SS_PAUSED", "SS_PULL_MODE"];
var VIZ_CODES = Object.freeze({
  cli: Object.freeze([
    "UI_VIZ_OPENED",
    "UI_VIZ_URL",
    "UI_VIZ_OPEN_FAILED",
    "UI_VIZ_TERMINAL_ONLY",
    "RF_VIZ_START_FAILED",
    "RF_VIZ_BIND_FAILED",
    "RF_VIZ_NO_ROOMS",
    "RF_VIZ_REPO_NOT_LIVE",
    "RF_VIZ_DEMO_INVALID"
  ]),
  page: Object.freeze([
    "UI_VIZ_STOPPED",
    "UI_VIZ_LINK_EXPIRED",
    "UI_VIZ_LINK_REUSED",
    "UI_VIZ_NEED_LINK",
    "UI_VIZ_BAD_HOST",
    "UI_VIZ_NOT_FOUND",
    "UI_VIZ_NO_ROOMS",
    "UI_VIZ_ROOM_AMBIGUOUS",
    "UI_VIZ_ROOM_DOWN",
    "UI_VIZ_ROOM_GONE",
    "UI_VIZ_NO_BOARD",
    "UI_VIZ_RECONNECTING",
    "UI_VIZ_VERSION_SKEW",
    "UI_VIZ_NEWER_PROTOCOL",
    "UI_VIZ_CHECKPOINT_MISMATCH",
    "UI_VIZ_INCIDENT_FROZEN",
    "UI_VIZ_STATUS_UNREADABLE",
    "UI_VIZ_LAST_FETCH",
    "UI_VIZ_BOARD_FULL",
    "UI_VIZ_BOARD_NEAR_FULL",
    "UI_VIZ_DEMO_BANNER",
    ...DEMO_CAPTION_CODES,
    "UI_VIZ_CAUGHT_UP",
    "UI_VIZ_NEW_PILL",
    "UI_VIZ_MORE",
    "UI_VIZ_SEEN_AGO",
    "UI_VIZ_SEEN_BEFORE_OPEN"
  ]),
  scene: Object.freeze([
    "UI_VIZ_YOU",
    "UI_VIZ_LAST_SHARED_HERE",
    "UI_VIZ_HOLDING",
    "UI_VIZ_SHELF_DESK",
    "UI_VIZ_BIG_TABLE",
    "UI_VIZ_GRANT_PAUSE",
    "UI_VIZ_HOST_REFUSED",
    "UI_VIZ_LABEL_UNVERIFIED",
    "UI_VIZ_SCENE_SUMMARY",
    "UI_VIZ_SIGN_BASE_MOVE",
    "UI_VIZ_TAG_RESERVED",
    "UI_VIZ_TAG_LINES",
    "UI_VIZ_TAG_CHECKS",
    "UI_VIZ_CHIP_ASKED_AGAIN",
    "UI_VIZ_BUBBLE_GO_FIRST",
    "UI_VIZ_BADGE_VERSION",
    "UI_VIZ_BADGE_RULES",
    "UI_VIZ_BADGE_CREDIT",
    "UI_VIZ_BADGE_HEALTH"
  ]),
  icon: Object.freeze([
    "UI_VIZ_ICON_QUEUED",
    "UI_VIZ_ICON_ASKED",
    "UI_VIZ_ICON_AWAITING_HUMAN",
    "UI_VIZ_ICON_UNDELIVERABLE",
    "UI_VIZ_ICON_ACCEPTED",
    "UI_VIZ_ICON_DECLINED",
    "UI_VIZ_ICON_LATER",
    "UI_VIZ_ICON_DAEMON",
    "UI_VIZ_ICON_WAKE"
  ]),
  card: Object.freeze([
    "UI_VIZ_CARD_ROOM_OPEN",
    "UI_VIZ_CARD_JOIN",
    "UI_VIZ_CARD_REJOIN",
    "UI_VIZ_CARD_LEAVE",
    "UI_VIZ_CARD_SEAT_START",
    "UI_VIZ_CARD_SEAT_END",
    "UI_VIZ_CARD_REQUEST",
    "UI_VIZ_CARD_ANSWER",
    "UI_VIZ_CARD_NOTE",
    "UI_VIZ_CARD_K4",
    "UI_VIZ_CARD_CONFLICT",
    "UI_VIZ_CARD_BREACH",
    "UI_VIZ_CARD_ABSENT",
    "UI_VIZ_CARD_SAVE",
    "UI_VIZ_CARD_FREEZE",
    "UI_VIZ_CARD_THAW",
    "UI_VIZ_CARD_SLOWED",
    "UI_VIZ_CARD_NONRETRYABLE",
    "UI_VIZ_CARD_BASE_MOVE",
    "UI_VIZ_CARD_BOARD_FULL",
    "UI_VIZ_CARD_VERSION",
    "UI_VIZ_CARD_RULES",
    "UI_VIZ_CARD_HEALTH",
    "UI_VIZ_CARD_PUBLISH"
  ]),
  recording: Object.freeze([
    "UI_VIZ_RECORD_NOTICE",
    "UI_VIZ_RECORD_UNSUPPORTED",
    "UI_VIZ_RECORD_CAP",
    "UI_VIZ_RECORD_SIZE",
    "UI_VIZ_RECORD_INTERRUPTED",
    "UI_VIZ_ANON_ROOM",
    "UI_VIZ_ANON_NAME_APRICOT",
    "UI_VIZ_ANON_NAME_AMBER",
    "UI_VIZ_ANON_NAME_SKY",
    "UI_VIZ_ANON_NAME_GREEN",
    "UI_VIZ_ANON_NAME_LEMON",
    "UI_VIZ_ANON_NAME_BLUE",
    "UI_VIZ_ANON_NAME_PINK",
    "UI_VIZ_ACC_BEANIE",
    "UI_VIZ_ACC_HEADPHONES",
    "UI_VIZ_ACC_SUNGLASSES",
    "UI_VIZ_ACC_SCARF",
    "UI_VIZ_ACC_SPROUT",
    "UI_VIZ_ACC_CAP",
    "UI_VIZ_ACC_BOW",
    "UI_VIZ_ACC_GLASSES"
  ]),
  control: Object.freeze([
    "UI_VIZ_CTRL_PLAY",
    "UI_VIZ_CTRL_PAUSE",
    "UI_VIZ_CTRL_LIVE",
    "UI_VIZ_CTRL_SPEED",
    "UI_VIZ_CTRL_LOAD_EARLIER",
    "UI_VIZ_CTRL_RECORD",
    "UI_VIZ_CTRL_REDUCED_MOTION",
    "UI_VIZ_CTRL_LANGUAGE",
    "UI_VIZ_CTRL_ZOOM",
    "UI_VIZ_CTRL_COARSE",
    "UI_VIZ_CTRL_ANONYMIZE",
    "UI_VIZ_FILTER_ALL",
    "UI_VIZ_FILTER_PERSON",
    "UI_VIZ_FILTER_FILE",
    "UI_VIZ_FILTER_CONVERSATION",
    "UI_VIZ_FILTER_ACTIVITY",
    "UI_VIZ_FILTER_CONFLICTS",
    "UI_VIZ_FILTER_SYSTEM"
  ]),
  log: Object.freeze([
    "SEC_VIZ_BAD_HOST",
    "SEC_VIZ_BAD_ORIGIN",
    "SEC_VIZ_BAD_TOKEN",
    "SEC_VIZ_LAUNCH_REUSED",
    "SEC_VIZ_LAUNCH_EXPIRED",
    "SEC_VIZ_METHOD",
    "SEC_VIZ_LIMIT",
    "VIZ_EXIT_IDLE",
    "VIZ_EXIT_LIFETIME",
    "VIZ_EXIT_LAUNCH_UNUSED",
    "VIZ_EXIT_LAUNCH_REUSED",
    "VIZ_EXIT_PLUGIN_REMOVED",
    "VIZ_EXIT_SIGNAL",
    // R-V67: the viewer log's own marker for lines dropped while a rotation was blocked (spec-edit list 12 §3.10.10 and the §3.11
    // "Log only" row, not yet in the spec text).
    "VIZ_LOG_DROPPED"
  ]),
  reused: Object.freeze([
    ...PH,
    ...SS,
    "UI_DUR_S",
    "UI_DUR_MIN",
    "UI_DUR_H",
    "UI_INTERNAL_ERROR",
    "SEC_SECRET_REDACTED",
    "SEC_RECORD_INVALID",
    "SEC_REFUSE_RUNTIME_INTEGRITY",
    "RF_UNKNOWN_FLAG",
    "START_TOOL_VERSION"
  ])
});
var ALL_VIZ_CODES = new Set(Object.values(VIZ_CODES).flat());
var PAGE_SUBSET_PREFIXES = Object.freeze(["UI_VIZ_", "PH_", "SS_", "UI_DUR_"]);
var FREEZE_REASON_CODES = /* @__PURE__ */ new Set(["EPOCH", "MASS", "PAUSED", "INCIDENT", "CONFIG", "NOHOOKS"]);
var HEALTH_REASON_CODES = /* @__PURE__ */ new Set(["HOST_THROTTLED", "BOARD_FULL"]);
var PUBLISH_PAUSE_CODES = /* @__PURE__ */ new Set(["OFFLINE", "AUTH", "NONRETRYABLE", "VERSION"]);
var STATUS_STATES = /* @__PURE__ */ new Set(["ok", "degraded", "offline", "frozen", "incident", "paused", "refused", "down"]);
var PH_CODES = new Set(PH);
var SS_CODES = new Set(SS);
var CHARACTER_BADGES = /* @__PURE__ */ new Set([
  "UI_VIZ_BADGE_VERSION",
  "UI_VIZ_BADGE_RULES",
  "UI_VIZ_BADGE_CREDIT",
  "UI_VIZ_BADGE_HEALTH"
]);
var REASON_CODES = /* @__PURE__ */ new Set([...FREEZE_REASON_CODES, ...HEALTH_REASON_CODES, ...PUBLISH_PAUSE_CODES]);
var PAGE_CODES = /* @__PURE__ */ new Set([
  ...[...ALL_VIZ_CODES].filter((c) => PAGE_SUBSET_PREFIXES.some((p) => c.startsWith(p))),
  ...REASON_CODES,
  "UI_INTERNAL_ERROR"
]);

// src/viz/cli/strings.ts
var EN_VIZ_CLI = {
  UI_VIZ_OPENED: { text: "Opened the read-only viewer in your browser. It stops 10 minutes after you close the tab." },
  UI_VIZ_URL: { text: "Open this link in your browser (it works once, within 2 minutes): {url}", params: { url: "url" } },
  UI_VIZ_OPEN_FAILED: { text: "Could not open a browser from here. To open the read-only viewer, run in a terminal: {cmd}", params: { cmd: "cmd" } },
  UI_VIZ_TERMINAL_ONLY: { text: "The read-only viewer opens only from a terminal. Run there: {cmd}", params: { cmd: "cmd" } },
  RF_VIZ_START_FAILED: {
    text: "cowork-sync: the viewer did not start (no ready report within 5 seconds, 15 on Windows, or its data folder failed the owner check) [RF_VIZ_START_FAILED]\nnext: /cowork doctor"
  },
  RF_VIZ_BIND_FAILED: { text: "cowork-sync: the viewer could not listen on 127.0.0.1 [RF_VIZ_BIND_FAILED]\nnext: /cowork doctor" },
  RF_VIZ_NO_ROOMS: {
    text: "cowork-sync: no room to show; pass --repo with the folder of a repository where cowork-sync runs, or --demo for demo data [RF_VIZ_NO_ROOMS]\nnext: /cowork start"
  },
  RF_VIZ_REPO_NOT_LIVE: {
    text: "cowork-sync: that folder is not a main worktree with a fetched cowork-sync board [RF_VIZ_REPO_NOT_LIVE]\nnext: /cowork start"
  },
  RF_VIZ_DEMO_INVALID: {
    text: "cowork-sync: the demo file is not a valid cowork-viz-demo/1 log (first bad line: {n}) [RF_VIZ_DEMO_INVALID]\nnext: (none: fix the demo file)",
    params: { n: "n" }
  },
  RF_UNKNOWN_FLAG: {
    text: "cowork-sync: unknown flag; view takes --no-open and either --demo, --demo=FILE or --repo FOLDER (repeatable) [RF_UNKNOWN_FLAG]\nnext: (none: run view with only those flags)"
  },
  START_TOOL_VERSION: {
    text: "cowork-sync: git 2.43 or newer is needed, installed outside your repositories [START_TOOL_VERSION]\nnext: /cowork doctor"
  },
  UI_INTERNAL_ERROR: {
    text: "cowork-sync: internal error; nothing was changed. To collect a report, run /cowork doctor --bundle with a folder outside this repository."
  }
};

// src/viz/i18n/en.ts
var COUNTED = { params: { n: "n" }, plural: "n" };
var EN_VIZ = {
  ...EN_VIZ_CLI,
  // Page states
  UI_VIZ_STOPPED: { text: "The viewer stopped. Run /cowork view to open it again." },
  UI_VIZ_LINK_EXPIRED: { text: "This link has expired. Run /cowork view again." },
  UI_VIZ_LINK_REUSED: {
    text: "This link was opened twice, so the viewer stopped. If you did not open it twice, another program or user on this PC may have opened it. Run /cowork view again."
  },
  UI_VIZ_NEED_LINK: { text: "Open the viewer with the link that /cowork view gives you." },
  UI_VIZ_BAD_HOST: { text: "This address is not the viewer. Open the link that /cowork view gives you." },
  UI_VIZ_NOT_FOUND: { text: "Nothing here." },
  UI_VIZ_NO_ROOMS: { text: "No rooms to show." },
  UI_VIZ_ROOM_AMBIGUOUS: { text: "This room matches more than one board on this PC, so it is not shown." },
  UI_VIZ_ROOM_DOWN: { text: "cowork-sync is not running on this PC" },
  UI_VIZ_ROOM_GONE: { text: "This room is no longer on this PC." },
  UI_VIZ_NO_BOARD: { text: "Part of the shared history is missing on this PC; waiting for the next fetch." },
  UI_VIZ_RECONNECTING: { text: "Reconnecting…" },
  UI_VIZ_VERSION_SKEW: { text: "cowork-sync on this PC is another version than the viewer." },
  UI_VIZ_NEWER_PROTOCOL: { text: "This board was written by a newer cowork-sync; parts of it are not shown. Update cowork-sync." },
  UI_VIZ_CHECKPOINT_MISMATCH: { text: "A board checkpoint does not match the history before it; the history as folded here is shown." },
  UI_VIZ_INCIDENT_FROZEN: { text: "The shared history was rewritten; this room stays at its last good scene." },
  UI_VIZ_STATUS_UNREADABLE: { text: "The status of cowork-sync on this PC could not be read." },
  UI_VIZ_LAST_FETCH: { text: "last fetch {n} min ago", params: { n: "n" } },
  UI_VIZ_BOARD_FULL: { text: "board full" },
  UI_VIZ_BOARD_NEAR_FULL: { text: "board nearly full" },
  UI_VIZ_DEMO_BANNER: { text: "Demo data — not your team" },
  UI_VIZ_DEMO_CAPTION_1: { text: "A team room opens: one branch, shared live through git." },
  UI_VIZ_DEMO_CAPTION_2: { text: "Three people join, each from their own PC." },
  UI_VIZ_DEMO_CAPTION_3: { text: "Each change-set lands on the desks of its files; paper planes fly to the other files it touched." },
  UI_VIZ_DEMO_CAPTION_4: { text: "A git command outside cowork-sync pauses one person; a busy host slows another down." },
  UI_VIZ_DEMO_CAPTION_5: { text: "Three people, three PCs, only git in between." },
  UI_VIZ_CAUGHT_UP: { text: "caught up" },
  UI_VIZ_NEW_PILL: { text: "new" },
  UI_VIZ_MORE: { text: "+{n}", params: { n: "n" } },
  UI_VIZ_SEEN_AGO: { text: "seen {n} min ago", params: { n: "n" } },
  UI_VIZ_SEEN_BEFORE_OPEN: { text: "before this view opened" },
  // Scene labels
  UI_VIZ_YOU: { text: "you" },
  UI_VIZ_LAST_SHARED_HERE: { text: "last shared here: {path} (#{height})", params: { path: "path", height: "n" } },
  UI_VIZ_HOLDING: { text: "holding {label}", params: { label: "label" } },
  UI_VIZ_SHELF_DESK: { text: "more files in {zone}", params: { zone: "path" } },
  UI_VIZ_BIG_TABLE: { text: "{n} files", ...COUNTED, forms: { one: "{n} file", other: "{n} files" } },
  UI_VIZ_GRANT_PAUSE: { text: "paused for {name}'s change", params: { name: "name" } },
  UI_VIZ_HOST_REFUSED: { text: "the host refused pushes from this PC for a while; sharing has resumed" },
  UI_VIZ_LABEL_UNVERIFIED: { text: "label not verified" },
  UI_VIZ_SCENE_SUMMARY: {
    text: "{people} people, {sessions} Claude sessions, {open} requests open, {conflicts} conflicts",
    params: { people: "n", sessions: "n", open: "n", conflicts: "n" }
  },
  UI_VIZ_SIGN_BASE_MOVE: { text: "following the saved branch" },
  UI_VIZ_TAG_RESERVED: { text: "reserved for {id}", params: { id: "id" } },
  UI_VIZ_TAG_LINES: { text: "lines {lo}–{hi}", params: { lo: "n", hi: "n" } },
  UI_VIZ_TAG_CHECKS: { text: "waiting for checks" },
  UI_VIZ_CHIP_ASKED_AGAIN: { text: "asked again" },
  UI_VIZ_BUBBLE_GO_FIRST: { text: "go first? ~{est_minutes} min", params: { est_minutes: "n" } },
  UI_VIZ_BADGE_VERSION: { text: "another version" },
  UI_VIZ_BADGE_RULES: { text: "different rules" },
  UI_VIZ_BADGE_CREDIT: { text: "co-author credit" },
  UI_VIZ_BADGE_HEALTH: { text: "health notice" },
  // Icons (screen-reader labels)
  UI_VIZ_ICON_QUEUED: { text: "queued until the turn ends" },
  UI_VIZ_ICON_ASKED: { text: "asked" },
  UI_VIZ_ICON_AWAITING_HUMAN: { text: "waiting for a person" },
  UI_VIZ_ICON_UNDELIVERABLE: { text: "could not be delivered" },
  UI_VIZ_ICON_ACCEPTED: { text: "accepted" },
  UI_VIZ_ICON_DECLINED: { text: "declined" },
  UI_VIZ_ICON_LATER: { text: "later" },
  UI_VIZ_ICON_DAEMON: { text: "answered by cowork-sync" },
  UI_VIZ_ICON_WAKE: { text: "woken up to work" },
  // Cards
  UI_VIZ_CARD_ROOM_OPEN: { text: "The room opened" },
  UI_VIZ_CARD_JOIN: { text: "{name} joined", params: { name: "name" } },
  UI_VIZ_CARD_REJOIN: { text: "{name} joined again", params: { name: "name" } },
  UI_VIZ_CARD_LEAVE: { text: "{name} left", params: { name: "name" } },
  UI_VIZ_CARD_SEAT_START: { text: "{name} started a Claude session", params: { name: "name" } },
  UI_VIZ_CARD_SEAT_END: { text: "{name} ended a Claude session", params: { name: "name" } },
  UI_VIZ_CARD_REQUEST: { text: "{name} asked {target} about {path} ({id})", params: { name: "name", target: "name", path: "path", id: "id" } },
  UI_VIZ_CARD_ANSWER: { text: "{name} answered {id}", params: { name: "name", id: "id" } },
  UI_VIZ_CARD_NOTE: { text: "{name} left a note", params: { name: "name" } },
  UI_VIZ_CARD_K4: { text: "{name}'s change to {path} could not be applied and is kept aside ({id})", params: { name: "name", path: "path", id: "id" } },
  UI_VIZ_CARD_CONFLICT: { text: "{name}'s change to {path} is held ({id})", params: { name: "name", path: "path", id: "id" } },
  UI_VIZ_CARD_BREACH: {
    text: "{name}'s change touches lines {target} holds in {path} ({id})",
    params: { name: "name", target: "name", path: "path", id: "id" }
  },
  UI_VIZ_CARD_ABSENT: { text: "{name} is not answering; their claims no longer block", params: { name: "name" } },
  UI_VIZ_CARD_SAVE: { text: "{name} saved", params: { name: "name" } },
  UI_VIZ_CARD_FREEZE: { text: "{name} paused sharing", params: { name: "name" } },
  UI_VIZ_CARD_THAW: { text: "{name} resumed sharing", params: { name: "name" } },
  UI_VIZ_CARD_SLOWED: { text: "{name} is sharing more slowly (the host is limiting pushes)", params: { name: "name" } },
  UI_VIZ_CARD_NONRETRYABLE: { text: "The host refused pushes from {name}'s PC for a while; sharing has resumed", params: { name: "name" } },
  UI_VIZ_CARD_BASE_MOVE: { text: "The room now follows the saved branch" },
  UI_VIZ_CARD_BOARD_FULL: { text: "The shared board is full" },
  UI_VIZ_CARD_VERSION: { text: "{name} now runs another cowork-sync version", params: { name: "name" } },
  UI_VIZ_CARD_RULES: { text: "{name} uses different rules from the team", params: { name: "name" } },
  UI_VIZ_CARD_HEALTH: { text: "{name} reported a health notice", params: { name: "name" } },
  UI_VIZ_CARD_PUBLISH: {
    text: "{name} shared {n} files",
    params: { name: "name", n: "n" },
    plural: "n",
    forms: { one: "{name} shared {n} file", other: "{name} shared {n} files" }
  },
  // Recording (8b)
  UI_VIZ_RECORD_NOTICE: { text: "This recording will show your teammates' names, file names and notes." },
  UI_VIZ_RECORD_UNSUPPORTED: { text: "This browser cannot record the view." },
  UI_VIZ_RECORD_CAP: { text: "The recording stopped at its length limit." },
  UI_VIZ_RECORD_SIZE: { text: "The recording stopped at its size limit." },
  UI_VIZ_RECORD_INTERRUPTED: { text: "The recording was interrupted." },
  UI_VIZ_ANON_ROOM: { text: "room" },
  UI_VIZ_ANON_NAME_APRICOT: { text: "Apricot" },
  UI_VIZ_ANON_NAME_AMBER: { text: "Amber" },
  UI_VIZ_ANON_NAME_SKY: { text: "Sky" },
  UI_VIZ_ANON_NAME_GREEN: { text: "Green" },
  UI_VIZ_ANON_NAME_LEMON: { text: "Lemon" },
  UI_VIZ_ANON_NAME_BLUE: { text: "Blue" },
  UI_VIZ_ANON_NAME_PINK: { text: "Pink" },
  UI_VIZ_ACC_BEANIE: { text: "beanie" },
  UI_VIZ_ACC_HEADPHONES: { text: "headphones" },
  UI_VIZ_ACC_SUNGLASSES: { text: "sunglasses" },
  UI_VIZ_ACC_SCARF: { text: "scarf" },
  UI_VIZ_ACC_SPROUT: { text: "sprout" },
  UI_VIZ_ACC_CAP: { text: "cap" },
  UI_VIZ_ACC_BOW: { text: "bow" },
  UI_VIZ_ACC_GLASSES: { text: "glasses" },
  // Controls and filters
  UI_VIZ_CTRL_PLAY: { text: "Play" },
  UI_VIZ_CTRL_PAUSE: { text: "Pause" },
  UI_VIZ_CTRL_LIVE: { text: "Live" },
  UI_VIZ_CTRL_SPEED: { text: "Speed" },
  UI_VIZ_CTRL_LOAD_EARLIER: { text: "Load earlier" },
  UI_VIZ_CTRL_RECORD: { text: "Record" },
  UI_VIZ_CTRL_REDUCED_MOTION: { text: "Reduce motion" },
  UI_VIZ_CTRL_LANGUAGE: { text: "Language" },
  UI_VIZ_CTRL_ZOOM: { text: "Zoom" },
  UI_VIZ_CTRL_COARSE: { text: "One table per folder" },
  UI_VIZ_CTRL_ANONYMIZE: { text: "Anonymize" },
  UI_VIZ_FILTER_ALL: { text: "All" },
  UI_VIZ_FILTER_PERSON: { text: "Person" },
  UI_VIZ_FILTER_FILE: { text: "File" },
  UI_VIZ_FILTER_CONVERSATION: { text: "Conversations" },
  UI_VIZ_FILTER_ACTIVITY: { text: "Activity" },
  UI_VIZ_FILTER_CONFLICTS: { text: "Conflicts" },
  UI_VIZ_FILTER_SYSTEM: { text: "System" },
  // Log only
  SEC_VIZ_BAD_HOST: { text: "A request with a foreign Host header was refused." },
  SEC_VIZ_BAD_ORIGIN: { text: "A request from another origin was refused." },
  SEC_VIZ_BAD_TOKEN: { text: "A request without a valid session was refused." },
  SEC_VIZ_LAUNCH_REUSED: { text: "The launch link was presented a second time." },
  SEC_VIZ_LAUNCH_EXPIRED: { text: "An expired launch link was presented." },
  SEC_VIZ_METHOD: { text: "A request with a method the viewer does not serve was refused." },
  SEC_VIZ_LIMIT: { text: "A request over a size or time limit was refused." },
  VIZ_EXIT_IDLE: { text: "The viewer stopped: no page was open for 10 minutes." },
  VIZ_EXIT_LIFETIME: { text: "The viewer stopped after 24 hours." },
  VIZ_EXIT_LAUNCH_UNUSED: { text: "The viewer stopped: its link was not opened within 2 minutes." },
  VIZ_EXIT_LAUNCH_REUSED: { text: "The viewer stopped: its link was opened twice." },
  VIZ_EXIT_PLUGIN_REMOVED: { text: "The viewer stopped: cowork-sync was removed or updated." },
  VIZ_EXIT_SIGNAL: { text: "The viewer stopped on a signal." },
  VIZ_LOG_DROPPED: {
    text: "The viewer log dropped {n} lines while it could not rotate.",
    ...COUNTED,
    forms: { one: "The viewer log dropped {n} line while it could not rotate.", other: "The viewer log dropped {n} lines while it could not rotate." }
  },
  // Reused: peer health and seat states (10-product section 3.14, verbatim), durations, shared codes
  PH_OK: { text: "live" },
  PH_OFFLINE: { text: "offline" },
  PH_PAUSED: { text: "paused" },
  PH_FROZEN: { text: "paused ({reason})", params: { reason: "reason" } },
  PH_NOT_COORDINATED: { text: "not coordinated (hooks off)" },
  PH_PRESUMED_ABSENT: { text: "not answering (claims no longer block)" },
  PH_LEFT: { text: "left" },
  PH_SLOWED: { text: "live, sharing slower (host limiting pushes)" },
  SS_FULL: { text: "coordinated" },
  SS_HOOK_ONLY: { text: "coordinated; notices shown at its next action" },
  SS_NO_MCP: { text: "coordinated; Claude cannot answer requests (MCP off)" },
  SS_NO_HOOKS: { text: "not coordinated (hooks off)" },
  SS_DEGRADED: { text: "coordination unreliable right now" },
  SS_PAUSED: { text: "paused" },
  SS_PULL_MODE: { text: "over its notice budget; notices shown at its next prompt" },
  UI_DUR_S: { text: "{n} seconds", ...COUNTED, forms: { one: "{n} second", other: "{n} seconds" } },
  UI_DUR_MIN: { text: "{n} minutes", ...COUNTED, forms: { one: "{n} minute", other: "{n} minutes" } },
  UI_DUR_H: { text: "{n} hours", ...COUNTED, forms: { one: "{n} hour", other: "{n} hours" } },
  SEC_SECRET_REDACTED: { text: "A value that looked like a secret was hidden." },
  SEC_RECORD_INVALID: { text: "A board record failed validation and was ignored." },
  SEC_REFUSE_RUNTIME_INTEGRITY: {
    text: "cowork-sync: the installed viewer does not match its checksum [SEC_REFUSE_RUNTIME_INTEGRITY]\nnext: /cowork doctor"
  },
  // Reason codes a {reason} parameter nests (R-V43): FREEZE_REASON_CODES, HEALTH_REASON_CODES, PUBLISH_PAUSE_CODES
  EPOCH: { text: "a git command outside cowork-sync" },
  MASS: { text: "a very large change" },
  PAUSED: { text: "paused by hand" },
  INCIDENT: { text: "the shared history was rewritten" },
  CONFIG: { text: "a setting changed" },
  NOHOOKS: { text: "hooks are off" },
  HOST_THROTTLED: { text: "the host is limiting pushes" },
  BOARD_FULL: { text: "the shared board is full" },
  OFFLINE: { text: "offline" },
  AUTH: { text: "signing in to the host failed" },
  NONRETRYABLE: { text: "the host refused a push" },
  VERSION: { text: "another cowork-sync version" }
};

// src/viz/server/project.ts
import { createHash as createHash3 } from "node:crypto";

// src/sec/validators.ts
var MAX_PATH_BYTES = 4096;
var LONE_SURROGATE2 = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function validPathSyntax(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0") || p.includes("\\") || p.includes(":") || p.startsWith("/")) return false;
  if (LONE_SURROGATE2.test(p)) return false;
  if (Buffer.byteLength(p, "utf8") > MAX_PATH_BYTES) return false;
  if (p.normalize("NFC") !== p) return false;
  for (const component of p.split("/")) {
    if (component.length === 0 || component === "..") return false;
  }
  return true;
}
var HEX128 = /^[0-9a-f]{32}$/;
var SEQ = /^[1-9][0-9]*$/;
var ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
function validOpId(s) {
  const parts = s.split("/");
  return parts.length === 3 && HEX128.test(parts[0] ?? "") && HEX128.test(parts[1] ?? "") && SEQ.test(parts[2] ?? "");
}
function validCsId(s) {
  const parts = s.split("/");
  if (parts.length === 2) return HEX128.test(parts[0] ?? "") && SEQ.test(parts[1] ?? "");
  if (parts.length === 3) return HEX128.test(parts[0] ?? "") && parts[1] === "human" && SEQ.test(parts[2] ?? "");
  return false;
}
function validId(kind, s) {
  if (typeof s !== "string") return false;
  switch (kind) {
    case "op":
      return validOpId(s);
    case "ulid":
      return ULID.test(s);
    case "cs":
      return validCsId(s);
    case "hex128":
      return HEX128.test(s);
  }
}
var NAME = /^[\p{L}\p{M}\p{N}_ .'-]{1,64}$/u;
function validName(s) {
  return typeof s === "string" && NAME.test(s);
}

// src/board/ids.ts
function parseOpId(s) {
  if (!validId("op", s)) return null;
  const [peer, epoch, seqText] = s.split("/");
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || String(seq) !== seqText) return null;
  return { peer, epoch, seq };
}
var CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function base32c(bytes2) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes2) {
    acc = acc << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[acc >>> bits & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[acc << 5 - bits & 31];
  return out;
}

// src/viz/model/events.ts
var KINDS = [
  "room_open",
  "person_enter",
  "person_respawn",
  "pet_poof",
  "claim_release",
  "person_badge",
  "person_exit",
  "pet_spawn",
  "publish",
  "room_sign",
  "person_freeze",
  "person_thaw",
  "person_slowed",
  "room_badge",
  "person_bang",
  "conflict",
  "box",
  "claim_take",
  "claim_move",
  "claim_stale",
  "claim_reserve",
  "grant_start",
  "grant_end",
  "request_open",
  "request_status",
  "answer",
  "note",
  "person_absent",
  "save",
  "person_ghost",
  "person_unghost",
  "pose_relaxed"
];
var SCENE_EVENT_KINDS = Object.freeze([...KINDS]);
var SUB_ROOM = 0;
var SUB_CODE = 1001;
var SUB_DERIVED = 1002;
function actorKey(a) {
  return "peer" in a ? `p:${a.peer}` : `s:${a.seat}`;
}

// src/viz/model/layout.ts
var ZONES_MAX = 15;
var CELLS_PER_ZONE = 4;
var SLOTS_PER_CELL = 6;
var FILE_DESKS_PER_ZONE = 23;
var OVERFLOW_ZONE = "…";
var ROOT_ZONE = "·";
var BIG_TABLE_KEY = "⌂";
var BIG_TABLE = 0;
var DOOR = Object.freeze({ x: 1, y: 0 });
function makeDesk(d) {
  return Object.freeze({
    ordinal: d.ordinal,
    key: d.key,
    kind: d.kind,
    zone: d.zone,
    cell: d.cell,
    slot: d.slot,
    path: d.path,
    lockbox: d.lockbox ?? false,
    first: d.first
  });
}
function copyZone(z) {
  return { index: z.index, key: z.key, cells: [...z.cells] };
}
var BIG_TABLE_DESK = makeDesk({ ordinal: BIG_TABLE, key: BIG_TABLE_KEY, kind: "big_table", zone: null, cell: null, slot: null, path: null, first: 0 });
function emptyLayout() {
  return { version: 0, zones: [], desks: [BIG_TABLE_DESK], homeOrder: [], deskOf: /* @__PURE__ */ new Map() };
}
function zoneOf(p) {
  const parts = p.split("/");
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0];
  return ROOT_ZONE;
}
var KEY_ESCAPE = ":";
var RESERVED_SEGMENTS = /* @__PURE__ */ new Set([OVERFLOW_ZONE, ROOT_ZONE, BIG_TABLE_KEY]);
function pathKey(s) {
  return s.split("/").map((seg) => RESERVED_SEGMENTS.has(seg) || seg.startsWith(KEY_ESCAPE) ? KEY_ESCAPE + seg : seg).join("/");
}
function unPathKey(s) {
  return s.split("/").map((seg) => seg.startsWith(KEY_ESCAPE) ? seg.slice(KEY_ESCAPE.length) : seg).join("/");
}
function zoneKeyOf(p) {
  return p.includes("/") ? pathKey(zoneOf(p)) : ROOT_ZONE;
}
var LayoutFrozenError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LayoutFrozenError";
  }
};
var LayoutBuilder = class {
  version;
  zones;
  zoneByKey = /* @__PURE__ */ new Map();
  desks;
  deskOf;
  /** Overflow folder zone(p) → its folder desk in '…'. */
  folderOf = /* @__PURE__ */ new Map();
  homeOrder;
  homeSet;
  cells;
  regularZones;
  frozen = false;
  takenVersion;
  takenDesks;
  takenHome;
  grown = /* @__PURE__ */ new Set();
  constructor(base) {
    this.version = base.version;
    this.zones = base.zones.map(copyZone);
    this.desks = base.desks.map((d) => makeDesk(d));
    this.deskOf = new Map(base.deskOf);
    this.homeOrder = [...base.homeOrder];
    this.homeSet = new Set(this.homeOrder);
    this.cells = 0;
    this.regularZones = 0;
    const states = this.zones.map((zone) => ({ zone, deskCount: 0, shelf: null }));
    for (const zs of states) {
      this.zoneByKey.set(zs.zone.key, zs);
      this.cells += zs.zone.cells.length;
      if (zs.zone.key !== OVERFLOW_ZONE) this.regularZones++;
    }
    for (const d of this.desks) {
      if (d.zone === null) continue;
      const zs = states[d.zone];
      if (zs === void 0) throw new RangeError(`layout: desk ${d.ordinal} names zone ${d.zone}, which does not exist`);
      if (d.kind === "shelf") zs.shelf = d.ordinal;
      else zs.deskCount++;
      if (d.kind === "folder") this.folderOf.set(d.key.slice(0, -1), d.ordinal);
    }
    this.takenVersion = this.version;
    this.takenDesks = this.desks.length;
    this.takenHome = this.homeOrder.length;
  }
  /** The desk of a desk-eligible path, allocated on first touch at height h (Desk.first = h). */
  desk(path2, h) {
    const known = this.deskOf.get(path2);
    if (known !== void 0) return known;
    if (this.frozen) throw new LayoutFrozenError(`layout is frozen: no desk for a path first touched at height ${h}`);
    let key = zoneKeyOf(path2);
    let folder = null;
    let zs = this.zoneByKey.get(key);
    if (zs === void 0 && this.regularZones >= ZONES_MAX) {
      folder = key;
      const existing = this.folderOf.get(folder);
      if (existing !== void 0) {
        this.deskOf.set(path2, existing);
        return existing;
      }
      key = OVERFLOW_ZONE;
      zs = this.zoneByKey.get(key);
    }
    zs ??= this.newZone(key);
    let ref;
    if (zs.deskCount < FILE_DESKS_PER_ZONE) {
      const n = zs.deskCount;
      const cellIndex = Math.floor(n / SLOTS_PER_CELL);
      if (cellIndex >= zs.zone.cells.length) this.addCell(zs);
      ref = this.addDesk({
        kind: folder === null ? "file" : "folder",
        key: folder === null ? pathKey(path2) : `${folder}/`,
        zone: zs.zone.index,
        cell: zs.zone.cells[cellIndex],
        slot: n % SLOTS_PER_CELL,
        path: folder === null ? path2 : null,
        first: h
      });
      zs.deskCount++;
      if (folder !== null) this.folderOf.set(folder, ref);
    } else {
      if (zs.shelf === null) {
        zs.shelf = this.addDesk({
          kind: "shelf",
          key: `${zs.zone.key}/${OVERFLOW_ZONE}`,
          zone: zs.zone.index,
          cell: zs.zone.cells[CELLS_PER_ZONE - 1],
          slot: SLOTS_PER_CELL - 1,
          path: null,
          first: h
        });
      }
      ref = zs.shelf;
    }
    this.deskOf.set(path2, ref);
    return ref;
  }
  has(path2) {
    return this.deskOf.has(path2);
  }
  /** Appends a peer to homeOrder when absent, one version step (R-V57); home spots never move (§3.6). */
  home(peer) {
    if (this.homeSet.has(peer)) return;
    if (this.frozen) throw new LayoutFrozenError("layout is frozen: no new home spot");
    this.homeSet.add(peer);
    this.homeOrder.push(peer);
    this.version++;
  }
  /** Later allocation throws LayoutFrozenError (re-fold of a retained range on the head layout). */
  freeze() {
    this.frozen = true;
  }
  /** A snapshot: new arrays, new zones and a new Map; desks are immutable and shared. */
  layout() {
    return { version: this.version, zones: this.zones.map(copyZone), desks: [...this.desks], homeOrder: [...this.homeOrder], deskOf: new Map(this.deskOf) };
  }
  /** The additions since the previous takeDelta (or the base): new or grown zones, new desks, new home entries; null when none. */
  takeDelta() {
    if (this.desks.length === this.takenDesks && this.homeOrder.length === this.takenHome && this.grown.size === 0) return null;
    const d = {
      fromVersion: this.takenVersion,
      version: this.version,
      zones: [...this.grown].sort((a, b) => a - b).map((i) => copyZone(this.zones[i])),
      desks: this.desks.slice(this.takenDesks),
      homeOrder: this.homeOrder.slice(this.takenHome)
    };
    this.takenVersion = this.version;
    this.takenDesks = this.desks.length;
    this.takenHome = this.homeOrder.length;
    this.grown.clear();
    return d;
  }
  newZone(key) {
    const zone = { index: this.zones.length, key, cells: [] };
    const zs = { zone, deskCount: 0, shelf: null };
    this.zones.push(zone);
    this.zoneByKey.set(key, zs);
    if (key !== OVERFLOW_ZONE) this.regularZones++;
    this.addCell(zs);
    return zs;
  }
  /** The next free grid cell, in creation order. */
  addCell(zs) {
    if (zs.zone.cells.length >= CELLS_PER_ZONE) throw new RangeError(`layout: zone ${zs.zone.index} already has ${CELLS_PER_ZONE} cells`);
    zs.zone.cells.push(this.cells++);
    this.grown.add(zs.zone.index);
    this.version++;
  }
  addDesk(d) {
    const desk = makeDesk({ ordinal: this.desks.length, ...d });
    this.desks.push(desk);
    this.version++;
    return desk.ordinal;
  }
};
function plaqueOf(d) {
  if (d.kind === "file") {
    const p = d.path ?? unPathKey(d.key);
    return p.slice(p.lastIndexOf("/") + 1);
  }
  if (d.kind === "folder") return unPathKey(d.key.endsWith("/") ? d.key.slice(0, -1) : d.key);
  return null;
}

// src/viz/model/placement.ts
function comparePos(a, b) {
  if (a.height !== b.height) return a.height < b.height ? -1 : 1;
  if (a.sub !== b.sub) return a.sub < b.sub ? -1 : 1;
  if (a.k !== b.k) return a.k < b.k ? -1 : 1;
  return 0;
}
function targetDesk(desks, layout, lastDesk) {
  if (desks.length === 0) return { target: BIG_TABLE, others: [] };
  const count = /* @__PURE__ */ new Map();
  for (const d of desks) count.set(d, (count.get(d) ?? 0) + 1);
  let max = 0;
  for (const n of count.values()) if (n > max) max = n;
  const tied = [...count.keys()].filter((d) => count.get(d) === max);
  const target = lastDesk !== null && tied.includes(lastDesk) ? lastDesk : tied.reduce((a, b) => compareDeskKeys(layout, a, b) <= 0 ? a : b);
  return { target, others: [...count.keys()].filter((d) => d !== target).sort((a, b) => a - b) };
}
function compareDeskKeys(layout, a, b) {
  const ka = layout.desks[a]?.key, kb = layout.desks[b]?.key;
  if (ka !== void 0 && kb !== void 0 && ka !== kb) return ka < kb ? -1 : 1;
  if (ka === void 0 && kb !== void 0) return 1;
  if (kb === void 0 && ka !== void 0) return -1;
  return a - b;
}
function homeSpot(layout, peer) {
  const i = layout.homeOrder.indexOf(peer);
  return i >= 0 ? i : layout.homeOrder.length;
}
function indexOf(s) {
  const ix = { requestsFrom: /* @__PURE__ */ new Map(), newestHeld: /* @__PURE__ */ new Map(), stoolDesks: /* @__PURE__ */ new Map(), petsOf: /* @__PURE__ */ new Map() };
  for (const [id, r] of s.requests) push(ix.requestsFrom, actorKey(r.from), { id, holder: r.holder, desk: r.desk });
  for (const c of s.claims.values()) {
    if (!c.stale) {
      const cur = ix.newestHeld.get(c.seat);
      if (cur === void 0 || comparePos(c.at, cur.at) > 0) ix.newestHeld.set(c.seat, { desk: c.desk, at: c.at });
    }
    if (c.grantee !== null) add(ix.stoolDesks, actorKey(c.grantee), c.desk);
  }
  for (const [seat, p] of s.pets) if (p.live) push(ix.petsOf, p.owner, [seat, p]);
  return ix;
}
function push(m, k, v) {
  const a = m.get(k);
  if (a === void 0) m.set(k, [v]);
  else a.push(v);
}
function add(m, k, v) {
  const a = m.get(k);
  if (a === void 0) m.set(k, /* @__PURE__ */ new Set([v]));
  else a.add(v);
}
var copyActor = (a) => "peer" in a ? { peer: a.peer } : { seat: a.seat };
var sameActor = (a, b) => actorKey(a) === actorKey(b);
function deskOfPlace(p) {
  return p.at === "home" || p.at === "behind" ? null : p.desk;
}
function pickDesk(s, candidates, hinted, current) {
  if (hinted !== null && candidates.has(hinted)) return hinted;
  if (current !== null && candidates.has(current)) return current;
  let best = null, bestEvent = -Infinity;
  for (const d of candidates) {
    const e = s.desks.get(d)?.lastEvent ?? -1;
    if (best === null || e > bestEvent || e === bestEvent && d < best) {
      best = d;
      bestEvent = e;
    }
  }
  return best;
}
function facingOf(ix, key, current, hint) {
  const requests = ix.requestsFrom.get(key);
  if (requests === void 0) return null;
  if (hint !== null && hint.actor === key && hint.kind === "face") {
    const r = requests.find((q) => q.id === hint.request);
    if (r !== void 0) return { at: "facing", actor: copyActor(r.holder), desk: r.desk };
  }
  if (current.at === "facing") {
    const cur = current;
    const r = requests.find((q) => q.desk === cur.desk && sameActor(q.holder, cur.actor));
    if (r !== void 0) return { at: "facing", actor: copyActor(r.holder), desk: r.desk };
  }
  return null;
}
function petSpot(s, ix, seat, p, hint) {
  if (!p.live) return { place: { at: "behind", peer: p.owner } };
  const key = actorKey({ seat });
  const facing = facingOf(ix, key, p.place, hint);
  if (facing !== null) return { place: facing };
  const held = ix.newestHeld.get(seat);
  if (held !== void 0) return { desk: held.desk };
  const stools = ix.stoolDesks.get(key);
  if (stools !== void 0) {
    const at = pickDesk(s, stools, hint !== null && hint.actor === key && hint.kind === "stool" ? hint.desk : null, p.place.at === "stool" ? p.place.desk : null);
    return { place: { at: "stool", desk: at } };
  }
  if (p.lastDesk !== null) return { desk: p.lastDesk };
  return { place: { at: "behind", peer: p.owner } };
}
function characterSpot(s, ix, layout, peer, c, petSpots, hint) {
  const home = { place: { at: "home", spot: homeSpot(layout, peer) } };
  if (c.absent || c.ghost) return home;
  const facing = facingOf(ix, actorKey({ peer }), c.place, hint);
  if (facing !== null) return { place: facing };
  const pets = ix.petsOf.get(peer) ?? [];
  if (c.lastPublish !== null && c.lastDesk !== null) {
    const lastPublish = c.lastPublish;
    if (pets.every(([, p]) => p.lastClaimOp === null || comparePos(lastPublish, p.lastClaimOp) > 0)) return { desk: c.lastDesk };
  }
  if (pets.some(([seat]) => ix.newestHeld.has(seat))) {
    const count = /* @__PURE__ */ new Map();
    for (const [seat] of pets) {
      const sp = petSpots.get(actorKey({ seat }));
      const d = sp === void 0 ? null : "desk" in sp ? sp.desk : sp.place.at === "stool" ? sp.place.desk : null;
      if (d !== null) count.set(d, (count.get(d) ?? 0) + 1);
    }
    let max = 0;
    for (const n of count.values()) if (n > max) max = n;
    if (max > 0) {
      const tied = new Set([...count.keys()].filter((d) => count.get(d) === max));
      return { place: { at: "beside", desk: pickDesk(s, tied, null, c.place.at === "beside" ? c.place.desk : null) } };
    }
  }
  return home;
}
function heldAt(s, d) {
  const out = /* @__PURE__ */ new Map();
  for (const c of s.claims.values()) {
    if (c.stale || c.desk !== d) continue;
    const cur = out.get(c.seat);
    if (cur === void 0 || comparePos(c.at, cur) > 0) out.set(c.seat, c.at);
  }
  return out;
}
function seatOrder(s, d, actors) {
  const held = heldAt(s, d);
  const stateOf = (a) => "peer" in a ? s.characters.get(a.peer) : s.pets.get(a.seat);
  const newestFirst = (x, y) => x === null ? y === null ? 0 : 1 : y === null ? -1 : comparePos(y, x);
  const fallback = (a, b) => {
    const va = "seat" in a ? s.pets.get(a.seat)?.variant ?? 0 : -1, vb = "seat" in b ? s.pets.get(b.seat)?.variant ?? 0 : -1;
    if (va !== vb) return va - vb;
    const ka = actorKey(a), kb = actorKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  const heldOf = (a) => "seat" in a ? held.get(a.seat) ?? null : null;
  const holders = actors.filter((a) => heldOf(a) !== null);
  const publishers = actors.filter((a) => heldOf(a) === null);
  holders.sort((a, b) => newestFirst(heldOf(a), heldOf(b)) || fallback(a, b));
  publishers.sort((a, b) => newestFirst(stateOf(a)?.lastPublish ?? null, stateOf(b)?.lastPublish ?? null) || fallback(a, b));
  return [...holders, ...publishers];
}
var VISITOR_TILES_SHOWN = 4;
function seatsOf(order) {
  const rest = order.slice(1);
  return { chair: order[0] === void 0 ? null : copyActor(order[0]), visitors: rest.slice(0, VISITOR_TILES_SHOWN).map(copyActor), more: Math.max(0, rest.length - VISITOR_TILES_SHOWN) };
}
function seatPlace(d, i) {
  return i === 0 ? { at: "chair", desk: d } : { at: "visitor", desk: d, tile: i - 1 };
}
var sitPose = (p) => p.at === "chair" || p.at === "stool" ? "sit" : "idle";
function samePlace(a, b) {
  switch (a.at) {
    case "home":
      return b.at === "home" && a.spot === b.spot;
    case "behind":
      return b.at === "behind" && a.peer === b.peer;
    case "visitor":
      return b.at === "visitor" && a.desk === b.desk && a.tile === b.tile;
    case "facing":
      return b.at === "facing" && a.desk === b.desk && sameActor(a.actor, b.actor);
    default:
      return b.at === a.at && deskOfPlace(b) === a.desk;
  }
}
var emptyDesk = () => ({ lastEvent: null, chair: null, visitors: [], more: 0, claims: [] });
function settlePlaces(s, layout, hint, reset) {
  const ix = indexOf(s);
  const spots = /* @__PURE__ */ new Map();
  for (const [seat, p] of s.pets) if (p.live) spots.set(actorKey({ seat }), petSpot(s, ix, seat, p, hint));
  for (const [peer, c] of s.characters) spots.set(actorKey({ peer }), characterSpot(s, ix, layout, peer, c, spots, hint));
  const groups = /* @__PURE__ */ new Map();
  const actorOf = (key, peerOrSeat, isPeer) => {
    const sp = spots.get(key);
    if ("desk" in sp) push(groups, sp.desk, isPeer ? { peer: peerOrSeat } : { seat: peerOrSeat });
  };
  for (const peer of s.characters.keys()) actorOf(actorKey({ peer }), peer, true);
  for (const [seat, p] of s.pets) if (p.live) actorOf(actorKey({ seat }), seat, false);
  const places = /* @__PURE__ */ new Map();
  for (const [key, sp] of spots) if ("place" in sp) places.set(key, sp.place);
  for (const [d, actors] of groups) {
    const order = seatOrder(s, d, actors);
    order.forEach((a, i) => places.set(actorKey(a), seatPlace(d, i)));
    const ds = s.desks.get(d) ?? emptyDesk();
    Object.assign(ds, seatsOf(order));
    s.desks.set(d, ds);
  }
  for (const [d, ds] of s.desks) {
    if (!groups.has(d)) Object.assign(ds, { chair: null, visitors: [], more: 0 });
    if (ds.lastEvent === null && ds.chair === null && ds.visitors.length === 0 && ds.claims.length === 0) s.desks.delete(d);
  }
  const apply = (key, st) => {
    const np = places.get(key);
    const moved = !samePlace(st.place, np);
    st.place = np;
    if (moved || key === reset) st.pose = sitPose(np);
  };
  for (const [peer, c] of s.characters) apply(actorKey({ peer }), c);
  for (const [seat, p] of s.pets) if (p.live) apply(actorKey({ seat }), p);
}

// src/viz/model/scene.ts
var RELAX_HEIGHTS = 64;
function emptyScene(at) {
  return {
    at: { height: at.height, sub: at.sub, k: at.k },
    badge: "none",
    branchMovedAt: null,
    characters: /* @__PURE__ */ new Map(),
    pets: /* @__PURE__ */ new Map(),
    desks: /* @__PURE__ */ new Map(),
    claims: /* @__PURE__ */ new Map(),
    requests: /* @__PURE__ */ new Map(),
    boxes: /* @__PURE__ */ new Map(),
    bangs: /* @__PURE__ */ new Map(),
    beat: []
  };
}
function cloneScene(s) {
  return structuredClone(s);
}
var posOf = (p) => ({ height: p.height, sub: p.sub, k: p.k });
var copyActor2 = (a) => "peer" in a ? { peer: a.peer } : { seat: a.seat };
function deskEntry(s, d) {
  let ds = s.desks.get(d);
  if (ds === void 0) {
    ds = { lastEvent: null, chair: null, visitors: [], more: 0, claims: [] };
    s.desks.set(d, ds);
  }
  return ds;
}
function touch(s, d, h) {
  if (d !== null) deskEntry(s, d).lastEvent = h;
}
function dropClaim(s, id, d) {
  const ds = s.desks.get(d);
  if (ds !== void 0) ds.claims = ds.claims.filter((x) => x !== id);
}
function listClaim(s, id, c) {
  const ds = deskEntry(s, c.desk);
  const before = (x) => {
    const o = s.claims.get(x);
    return o !== void 0 && (o.order < c.order || o.order === c.order && comparePos(o.at, c.at) < 0);
  };
  let i = 0;
  while (i < ds.claims.length && before(ds.claims[i])) i++;
  ds.claims.splice(i, 0, id);
}
function actorState(s, a) {
  if ("peer" in a) return s.characters.get(a.peer);
  const p = s.pets.get(a.seat);
  return p !== void 0 && p.live ? p : void 0;
}
function character(s, peer, f) {
  const c = s.characters.get(peer);
  if (c !== void 0) f(c);
}
function step(s, e, layout) {
  if (e.height !== s.at.height) s.beat = [];
  s.beat.push(structuredClone(e));
  s.at = posOf(e);
  let hint = null;
  let reset = null;
  switch (e.kind) {
    case "room_open":
    case "person_bang":
    // a one-beat "!" (§3.7): the beat holds it
    case "note":
    case "pose_relaxed":
      break;
    case "room_sign":
      s.branchMovedAt = e.height;
      break;
    case "room_badge":
      s.badge = e.level;
      break;
    case "person_enter":
    case "person_respawn": {
      const c = s.characters.get(e.peer);
      if (c === void 0) {
        s.characters.set(e.peer, {
          place: { at: "home", spot: homeSpot(layout, e.peer) },
          pose: "idle",
          lastPublish: null,
          lastDesk: null,
          lastClaimOp: null,
          ghost: false,
          absent: false,
          frozen: null,
          slowedUntil: null,
          rules: false,
          credit: false
        });
      } else {
        Object.assign(c, { absent: false, ghost: false, lastPublish: null, lastDesk: null, lastClaimOp: null });
      }
      reset = actorKey({ peer: e.peer });
      break;
    }
    case "person_exit":
      s.characters.delete(e.peer);
      break;
    case "person_absent":
      character(s, e.peer, (c) => {
        c.absent = true;
      });
      break;
    case "person_ghost":
      character(s, e.peer, (c) => {
        c.ghost = true;
      });
      break;
    case "person_unghost":
      character(s, e.peer, (c) => {
        c.ghost = false;
      });
      break;
    case "person_freeze":
      character(s, e.peer, (c) => {
        c.frozen = e.reasonCode;
      });
      break;
    case "person_thaw":
      character(s, e.peer, (c) => {
        c.frozen = null;
      });
      break;
    case "person_slowed":
      character(s, e.peer, (c) => {
        c.slowedUntil = e.until;
      });
      break;
    case "person_badge":
      if ("peer" in e.actor) {
        const c = s.characters.get(e.actor.peer);
        if (c !== void 0 && e.badge === "rules") c.rules = e.on;
        if (c !== void 0 && e.badge === "credit") c.credit = e.on;
      } else if (e.badge === "health") {
        const p = s.pets.get(e.actor.seat);
        if (p !== void 0 && p.live) p.ssCode = e.on ? e.code : null;
      }
      break;
    case "pet_spawn": {
      const p = s.pets.get(e.seat);
      if (p === void 0) {
        let variant = 0;
        for (const q of s.pets.values()) if (q.owner === e.owner) variant++;
        s.pets.set(e.seat, { place: { at: "behind", peer: e.owner }, pose: "idle", lastPublish: null, lastDesk: null, lastClaimOp: null, owner: e.owner, variant, live: true, ssCode: null });
        reset = actorKey({ seat: e.seat });
      } else if (!p.live) {
        Object.assign(p, { owner: e.owner, live: true, ssCode: null, lastPublish: null, lastDesk: null, lastClaimOp: null });
        reset = actorKey({ seat: e.seat });
      }
      break;
    }
    case "pet_poof": {
      const p = s.pets.get(e.seat);
      if (p !== void 0 && p.live) Object.assign(p, { live: false, ssCode: null, place: { at: "behind", peer: p.owner }, pose: "idle" });
      break;
    }
    case "publish": {
      const st = actorState(s, e.actor);
      if (st !== void 0) {
        st.lastPublish = posOf(e);
        st.lastDesk = e.target;
        reset = actorKey(e.actor);
      }
      touch(s, e.target, e.height);
      for (const d of e.others) touch(s, d, e.height);
      break;
    }
    case "conflict":
      if (e.source === "hold" && e.holdId !== null) s.bangs.set(e.holdId, { on: copyActor2(e.on), desk: e.desk });
      touch(s, e.desk, e.height);
      break;
    case "box":
      if (e.terminal) {
        s.boxes.delete(e.holdId);
        s.bangs.delete(e.holdId);
      } else {
        s.boxes.set(e.holdId, { owner: copyActor2(e.owner), desk: e.desk, holdKind: e.holdKind, residence: e.residence, state: e.state, localOnly: e.localOnly });
      }
      touch(s, e.desk, e.height);
      break;
    case "claim_take":
    case "claim_move": {
      const prev = s.claims.get(e.claimId);
      if (prev !== void 0) {
        dropClaim(s, e.claimId, prev.desk);
        touch(s, prev.desk, e.height);
      }
      const c = {
        seat: e.seat,
        desk: e.desk,
        order: e.order,
        label: e.label === null ? null : { simple: e.label.simple, qualname: e.label.qualname },
        granularity: e.granularity,
        lines: e.lines === null ? null : [e.lines[0], e.lines[1]],
        stale: false,
        reservedFor: prev?.reservedFor ?? null,
        grantee: prev === void 0 || prev.grantee === null ? null : copyActor2(prev.grantee),
        otherRules: e.otherRules,
        at: posOf(e)
      };
      s.claims.set(e.claimId, c);
      listClaim(s, e.claimId, c);
      touch(s, e.desk, e.height);
      const p = s.pets.get(e.seat);
      if (p !== void 0 && p.live) p.lastClaimOp = posOf(e);
      reset = actorKey({ seat: e.seat });
      break;
    }
    case "claim_stale": {
      const c = s.claims.get(e.claimId);
      if (c !== void 0) {
        c.stale = true;
        touch(s, c.desk, e.height);
      }
      break;
    }
    case "claim_release": {
      const c = s.claims.get(e.claimId);
      if (c !== void 0) {
        s.claims.delete(e.claimId);
        dropClaim(s, e.claimId, c.desk);
        touch(s, c.desk, e.height);
      }
      break;
    }
    case "claim_reserve": {
      const c = s.claims.get(e.claimId);
      if (c !== void 0) {
        c.reservedFor = e.request;
        touch(s, c.desk, e.height);
      }
      break;
    }
    case "grant_start":
    case "grant_end": {
      const c = s.claims.get(e.claimId);
      if (c !== void 0) {
        c.grantee = e.kind === "grant_start" ? copyActor2(e.grantee) : null;
        touch(s, c.desk, e.height);
        if (e.kind === "grant_start") {
          hint = { actor: actorKey(e.grantee), kind: "stool", desk: c.desk };
          reset = hint.actor;
        }
      }
      break;
    }
    case "request_open":
      s.requests.set(e.request, { from: copyActor2(e.from), holder: copyActor2(e.holder), desk: e.desk, status: null });
      touch(s, e.desk, e.height);
      hint = { actor: actorKey(e.from), kind: "face", request: e.request };
      reset = hint.actor;
      break;
    case "request_status": {
      const r = s.requests.get(e.request);
      if (r !== void 0 && e.status === "returned") s.requests.delete(e.request);
      else if (r !== void 0) r.status = e.status;
      break;
    }
    case "answer":
      if (e.verb !== "later") s.requests.delete(e.request);
      break;
    case "save":
      for (const d of e.desks) touch(s, d, e.height);
      break;
  }
  settlePlaces(s, layout, hint, reset);
  if (e.kind === "pose_relaxed") {
    const st = actorState(s, e.actor);
    if (st !== void 0) st.pose = "relaxed";
  }
}
var SceneReducer = class {
  s;
  layout;
  last;
  constructor(start, layout) {
    this.s = cloneScene(start);
    this.layout = layout;
    const b = start.beat.at(-1);
    this.last = b === void 0 ? null : posOf(b);
  }
  /**
   * Events in position order: one at or before the last pushed (or the start scene's last beat event), or before the start,
   * throws. Atomic: the event is applied to a copy, which replaces the scene only when the whole event applied.
   */
  push(e) {
    if (this.last !== null && comparePos(e, this.last) <= 0 || comparePos(e, this.s.at) < 0) {
      throw new RangeError(`SceneReducer.push: the event at ${e.height}.${e.sub}.${e.k} is not after ${this.s.at.height}.${this.s.at.sub}.${this.s.at.k}`);
    }
    const next = cloneScene(this.s);
    step(next, e, this.layout());
    this.s = next;
    this.last = posOf(e);
  }
  /** A deep copy. */
  scene() {
    return cloneScene(this.s);
  }
};
function firstAbove(events, h) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (events[mid].height > h) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function reduceScene(t, at) {
  const segs = t.segments;
  if (segs.length === 0) return emptyScene(at);
  let i = 0;
  for (let j = 0; j < segs.length; j++) if (segs[j].hs < at.height) i = j;
  const upTo = i + 1 < segs.length ? segs[i + 1].hs : Infinity;
  const s = cloneScene(segs[i].start);
  for (let x = i === 0 ? 0 : firstAbove(t.events, segs[i].hs); x < t.events.length; x++) {
    const e = t.events[x];
    if (e.height > upTo || comparePos(e, at) > 0) break;
    step(s, e, t.layout);
  }
  if (comparePos(at, s.at) > 0) {
    if (at.height !== s.at.height) s.beat = [];
    s.at = posOf(at);
  }
  return s;
}
function isSlowed(c, at) {
  return c.slowedUntil !== null && at.height < c.slowedUntil;
}

// src/viz/model/labels.ts
function phOf(c, status, at) {
  if (status === "left") return "PH_LEFT";
  if (status === "absent") return "PH_PRESUMED_ABSENT";
  if (c !== void 0 && c.frozen !== null) return c.frozen === "PAUSED" ? "PH_PAUSED" : c.frozen === "NOHOOKS" ? "PH_NOT_COORDINATED" : "PH_FROZEN";
  if (c !== void 0 && isSlowed(c, at)) return "PH_SLOWED";
  if (c !== void 0 && c.ghost) return null;
  return "PH_OK";
}

// src/viz/model/looks.ts
import { createHash as createHash2 } from "node:crypto";
var HUE_COUNT = 7;
var LOOK_COUNT = 56;
var LOOK_SALT = Buffer.from("viz-look", "utf8");
var NUL = Buffer.from([0]);
function lookOf(peer) {
  const n = createHash2("sha256").update(Buffer.concat([Buffer.from(peer, "utf8"), NUL, LOOK_SALT])).digest().readUInt32BE(0);
  const l = n % LOOK_COUNT;
  return { hue: l % HUE_COUNT, accessory: Math.floor(l / HUE_COUNT) };
}
function lookTable(peers) {
  const t = /* @__PURE__ */ new Map();
  for (const p of peers) if (!t.has(p)) t.set(p, lookOf(p));
  return t;
}

// src/viz/server/stream.ts
var SSE_MAX_BYTES = 65536;
var RING_EVENTS = 4096;
var RING_MS = 6e5;
var COMMENT_MS = 15e3;
var SSE_BUFFER_MAX = 1048576;
var RING_MAX_BYTES = SSE_BUFFER_MAX;
var LAST_EVENT_ID_RE = /^(0|[1-9][0-9]{0,15})$/;
var JSON_UNSAFE = /[<>&\u{2028}\u{2029}]/gu;
function escapeJson(v) {
  return (JSON.stringify(v) ?? "null").replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function frameSse(id, p) {
  return `id: ${id}
event: ${p.type}
data: ${escapeJson(p)}

`;
}
var COMMENT = ": \n\n";
function bytes(s) {
  return Buffer.byteLength(s, "utf8");
}
function size(x) {
  return bytes(escapeJson(x));
}
function added(len, count) {
  return len + (count > 0 ? 1 : 0);
}
function comparePos2(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function groupsOf(p) {
  const groups = p.events.map((e) => ({ event: e, eventLen: size(e), cards: [], cardLens: [], height: e.at[0] }));
  const byPos = /* @__PURE__ */ new Map();
  for (const g of groups) if (g.event !== null) byPos.set(g.event.at.join("."), g);
  for (const c of p.cards) {
    let g = byPos.get(c.at.join(".")) ?? groups.filter((x) => x.event !== null && comparePos2(x.event.at, c.at) <= 0).at(-1) ?? groups[0];
    if (g === void 0) {
      g = { event: null, eventLen: 0, cards: [], cardLens: [], height: c.at[0] };
      groups.push(g);
    }
    g.cards.push(c);
    g.cardLens.push(size(c));
  }
  return groups;
}
function splitTimeline(p, firstId) {
  const groups = groupsOf(p);
  const tickLens = p.ticks.map(size);
  const extras = p.characters.length > 0 || p.pets.length > 0;
  const parts = [];
  let nextTick = 0;
  const open = () => {
    const first = parts.length === 0;
    const empty = { ...p, events: [], cards: [], ticks: [], characters: first ? p.characters : [], pets: first ? p.pets : [] };
    return { events: [], cards: [], ticks: [], first, size: bytes(frameSse(firstId + parts.length, empty)) };
  };
  const carries = (part) => part.events.length + part.cards.length + part.ticks.length > 0 || part.first && extras;
  const probe = (part, g) => {
    let s = part.size;
    if (g.event !== null) s += added(g.eventLen, part.events.length);
    g.cardLens.forEach((l, i) => {
      s += added(l, part.cards.length + i);
    });
    let t = nextTick;
    for (; t < p.ticks.length && p.ticks[t].h <= g.height; t++) s += added(tickLens[t], part.ticks.length + t - nextTick);
    return { size: s, tickEnd: t };
  };
  let cur = open();
  if (cur.size > SSE_MAX_BYTES) return null;
  for (const g of groups) {
    let fit2 = probe(cur, g);
    if (fit2.size > SSE_MAX_BYTES) {
      if (!carries(cur)) return null;
      parts.push(cur);
      cur = open();
      fit2 = probe(cur, g);
      if (fit2.size > SSE_MAX_BYTES) return null;
    }
    if (g.event !== null) cur.events.push(g.event);
    cur.cards.push(...g.cards);
    cur.ticks.push(...p.ticks.slice(nextTick, fit2.tickEnd));
    nextTick = fit2.tickEnd;
    cur.size = fit2.size;
  }
  while (nextTick < p.ticks.length) {
    const s = cur.size + added(tickLens[nextTick], cur.ticks.length);
    if (s <= SSE_MAX_BYTES) {
      cur.ticks.push(p.ticks[nextTick]);
      cur.size = s;
      nextTick++;
    } else {
      if (!carries(cur)) return null;
      parts.push(cur);
      cur = open();
    }
  }
  parts.push(cur);
  const firstHeight2 = p.events[0]?.at[0];
  let h1 = firstHeight2 === void 0 ? p.h1 : Math.min(p.h1, Math.max(0, firstHeight2 - 1));
  return parts.map((part, i) => {
    h1 = i === parts.length - 1 ? p.h1 : Math.min(p.h1, Math.max(h1, part.events.at(-1)?.at[0] ?? h1));
    return {
      type: "timeline",
      room_id: p.room_id,
      h1,
      events: part.events,
      cards: part.cards,
      ticks: part.ticks,
      characters: part.first ? p.characters : [],
      pets: part.first ? p.pets : []
    };
  });
}
function fitSnapshot(p, id) {
  let total = bytes(frameSse(id, { ...p, cards: [] }));
  if (total > SSE_MAX_BYTES) return null;
  let keep = 0;
  for (let i = p.cards.length - 1; i >= 0; i--) {
    const next = total + added(size(p.cards[i]), keep);
    if (next > SSE_MAX_BYTES) break;
    total = next;
    keep++;
  }
  return [{ ...p, cards: p.cards.slice(p.cards.length - keep) }];
}
var StreamHub = class {
  constructor(clock) {
    this.clock = clock;
  }
  last = 0;
  /** Consecutive ids, oldest first. */
  ring = [];
  /** The UTF-8 bytes of the ring's frames. */
  ringBytes = 0;
  sinks = /* @__PURE__ */ new Set();
  byeFrame = null;
  /** Assigns the next id(s); a timeline payload over 64 KiB is split between events (never inside one), each part its own id; a layout
   *  delta or a snapshot scene over 64 KiB alone is replaced by one reset; a snapshot keeps as many of its newest cards as fit; a single
   *  event whose framed message with its card exceeds 64 KiB (unreachable under R-V50's budgets; pinned by a test) is replaced by one
   *  reset — the whole payload, so a page never holds half of it. */
  publish(p) {
    const id = this.last + 1;
    const whole = frameSse(id, p);
    if (bytes(whole) <= SSE_MAX_BYTES) {
      this.emit(whole);
      return;
    }
    const parts = p.type === "timeline" ? splitTimeline(p, id) : p.type === "room_snapshot" ? fitSnapshot(p, id) : null;
    const frames = parts?.map((q, i) => frameSse(id + i, q));
    if (frames === void 0 || frames.some((f) => bytes(f) > SSE_MAX_BYTES)) this.emit(frameSse(id, { type: "reset" }));
    else for (const f of frames) this.emit(f);
  }
  /** Valid, ≤ seq and covered by the ring (or no event yet) → replay every later event of every kind, then live; else one reset
   *  (carrying the current sequence; not an event of the ring), then live. The ring holds at most SSE_BUFFER_MAX bytes (R-V72), so a
   *  replay never passes it: a resume whose later events add up to more is older than the ring, and the page reloads /api/v1/world
   *  instead of taking a replay the stream cap would cut (R-V65). Never echoed or logged. */
  attach(out, lastEventId) {
    if (this.byeFrame !== null) {
      out.write(this.byeFrame);
      out.end();
      return;
    }
    const from = this.resumePoint(lastEventId);
    if (from === null) out.write(frameSse(this.last, { type: "reset" }));
    else for (const e of this.ring) if (e.id > from) out.write(e.frame);
    this.sinks.add(out);
    out.onClose(() => this.sinks.delete(out));
  }
  /** ': \n\n' to every sink (the 15 s timer). */
  comment() {
    for (const s of this.sinks) s.write(COMMENT);
  }
  /** bye to every sink, then end; a stream attached later gets bye at once. */
  close() {
    if (this.byeFrame !== null) return;
    const bye = frameSse(this.last + 1, { type: "bye" });
    this.emit(bye);
    this.byeFrame = bye;
    const sinks = [...this.sinks];
    this.sinks.clear();
    for (const s of sinks) s.end();
  }
  seq() {
    return this.last;
  }
  /** Open streams (the idle exit). */
  open() {
    return this.sinks.size;
  }
  resumePoint(lastEventId) {
    if (lastEventId === void 0 || !LAST_EVENT_ID_RE.test(lastEventId)) return null;
    const n = Number(lastEventId);
    if (n > this.last) return null;
    this.trim();
    const oldest = this.ring[0]?.id ?? this.last + 1;
    return n >= oldest - 1 ? n : null;
  }
  /** Records a frame framed with the next id and writes it to every sink. */
  emit(frame) {
    const id = ++this.last;
    const entry = { id, mono: this.clock.monoMs(), frame, bytes: bytes(frame) };
    this.ring.push(entry);
    this.ringBytes += entry.bytes;
    this.trim();
    for (const s of this.sinks) s.write(frame);
  }
  /** Drops the oldest entries past 4,096 events, older than 10 min (Δmono) or past RING_MAX_BYTES (1 MiB) of frames. */
  trim() {
    const now = this.clock.monoMs();
    let drop = 0;
    let dropped = 0;
    const over = () => {
      const e = this.ring[drop];
      return this.ring.length - drop > RING_EVENTS || now - e.mono > RING_MS || this.ringBytes - dropped > RING_MAX_BYTES;
    };
    while (drop < this.ring.length && over()) dropped += this.ring[drop++].bytes;
    if (drop > 0) {
      this.ring.splice(0, drop);
      this.ringBytes -= dropped;
    }
  }
};

// src/viz/server/project.ts
var PEER_HANDLE = 6;
var SEAT_HANDLE = 6;
var SHORT_ID = 8;
function lcp(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
var IdSpace = class {
  // digests, ascending UTF-16 order
  constructor(base, digest, onCollision) {
    this.base = base;
    this.digest = digest;
    this.onCollision = onCollision;
  }
  digestOf = /* @__PURE__ */ new Map();
  // id → digest
  lengthOf = /* @__PURE__ */ new Map();
  // digest → handle length
  sorted = [];
  handle(id) {
    let d = this.digestOf.get(id);
    if (d === void 0) {
      d = this.digest(id);
      this.digestOf.set(id, d);
      if (!this.lengthOf.has(d)) this.insert(d);
    }
    return d.slice(0, this.lengthOf.get(d));
  }
  insert(d) {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = lo + hi >>> 1;
      if (this.sorted[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    const neighbours = [this.sorted[lo - 1], this.sorted[lo]];
    this.sorted.splice(lo, 0, d);
    let need = this.base;
    for (const o of neighbours) {
      if (o === void 0) continue;
      const len = lcp(d, o) + 1;
      need = Math.max(need, len);
      const cur = this.lengthOf.get(o);
      if (len > cur) {
        this.lengthOf.set(o, len);
        if (o.slice(0, cur) !== o.slice(0, len)) this.onCollision();
      }
    }
    this.lengthOf.set(d, need);
  }
};
var seatDigest = (seat) => base32c(createHash3("sha256").update(seat, "utf8").digest());
function createHandleTable() {
  let collided = false;
  const flag = () => {
    collided = true;
  };
  const peers = new IdSpace(PEER_HANDLE, (p) => p, flag);
  const seats = new IdSpace(SEAT_HANDLE, seatDigest, flag);
  const shorts = new IdSpace(SHORT_ID, (id) => id, flag);
  return {
    peer: (p) => peers.handle(p),
    seat: (s) => seats.handle(s),
    shortId: (id) => shorts.handle(id),
    takeCollision: () => {
      const c = collided;
      collided = false;
      return c;
    }
  };
}
var CAP_OF = Object.freeze({
  name: "name",
  label: "label",
  path: "path",
  plaque: "plaque",
  branch: "branch",
  room: "room",
  caption: "caption",
  version: "version",
  sign: "path",
  note: "note",
  card: "card",
  tooltip: "tooltip"
});
var VALID_LABEL = /^[\p{L}\p{M}\p{N}_.:#<>,$@[\]()-]{1,200}$/u;
function vizText(kind, raw) {
  if (kind === "path" && !validPathSyntax(raw)) return "?";
  if (kind === "label" && !VALID_LABEL.test(raw)) return "?";
  return cap(sanitize(raw, "viz"), CAP_OF[kind]);
}
function vizCode(set, raw, fallback) {
  return raw !== null && set.has(raw) ? raw : fallback;
}
var PATHS_MAX_BYTES = 16384;
function servedPaths(paths) {
  const out = [];
  let size2 = 2;
  for (const p of paths) {
    const s = vizText("path", p);
    const add2 = Buffer.byteLength(escapeJson(s), "utf8") + (out.length > 0 ? 1 : 0);
    if (size2 + add2 > PATHS_MAX_BYTES) break;
    out.push(s);
    size2 += add2;
  }
  return out;
}
var EVENT_KINDS = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach", "freeze", "unfreeze", "incident", "nonretryable", "health"]);
var HOLD_KINDS = /* @__PURE__ */ new Set(["PATCH", "PIN", "INCOMING"]);
var HOLD_RESIDENCES = /* @__PURE__ */ new Set(["ON_DISK", "OFF_DISK"]);
var HOLD_STATES = /* @__PURE__ */ new Set(["ACTIVE", "CONFLICTED", "PARKED", "SUBSUMED", "GONE", "RESOLVED_PUBLISH", "RESOLVED_DISCARD"]);
var HOLD_OFFERS = /* @__PURE__ */ new Set(["none", "pending_leftover", "offered", "accepted", "returned"]);
var REQUEST_STATUSES = /* @__PURE__ */ new Set(["asked", "queued_until_turn_end", "awaiting_human", "undeliverable", "returned"]);
var ROOM_BADGES = /* @__PURE__ */ new Set([
  "UI_VIZ_VERSION_SKEW",
  "UI_VIZ_NEWER_PROTOCOL",
  "UI_VIZ_CHECKPOINT_MISMATCH",
  "UI_VIZ_INCIDENT_FROZEN",
  "UI_VIZ_NO_BOARD"
]);
var CAPTION_CODES = new Set(DEMO_CAPTION_CODES);
var DETAIL_SETS = /* @__PURE__ */ new Map([
  ["UI_VIZ_CARD_FREEZE", [FREEZE_REASON_CODES]],
  ["UI_VIZ_CARD_HEALTH", [HEALTH_REASON_CODES, SS_CODES]],
  ["UI_VIZ_CARD_SLOWED", [HEALTH_REASON_CODES]],
  ["UI_VIZ_CARD_BOARD_FULL", [HEALTH_REASON_CODES]],
  ["UI_VIZ_CARD_NONRETRYABLE", [PUBLISH_PAUSE_CODES]]
]);
var SEGMENTER3 = new Intl.Segmenter("en", { granularity: "grapheme" });
var TAG_SEP = " · ";
var ELLIPSIS2 = "…";
var HANDLE_LOOKALIKE = /[\s.\u{B7}\u{2022}-]+[0-9a-f]{6,}$/u;
var INVISIBLE = new RegExp("\\p{Default_Ignorable_Code_Point}", "gu");
var HANGUL_FILLER = /[\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;
function shownName(display) {
  if (display === null || !validName(display)) return null;
  const s = sanitize(display, "viz");
  return s.replace(INVISIBLE, "").trim() === "" ? null : s;
}
function cutGraphemes(s, n, units) {
  const gs = Array.from(SEGMENTER3.segment(s), (x) => x.segment);
  if (gs.length <= n && s.length <= units) return s;
  let out = "";
  for (let i = 0; i < gs.length && i < n - 1 && out.length + gs[i].length <= units - 1; i++) out += gs[i];
  return n > 0 && units > 0 ? out + ELLIPSIS2 : "";
}
function nameTag(display, handle, collide) {
  const shown = shownName(display);
  if (shown === null) return `peer-${handle}`;
  const tag = cap(shown, "name");
  if (!collide) return tag;
  const rest = TAG_SEP.length + handle.length;
  return `${cutGraphemes(tag, Math.max(0, VIZ_CAPS.name - rest), Math.max(0, VIZ_RAW_UNITS.name - rest))}${TAG_SEP}${handle}`;
}
var comparisonForm = (s) => s.replace(INVISIBLE, "").normalize("NFKC").replace(INVISIBLE, "").toLowerCase().replace(/\s+/gu, " ").trim();
var nameKeys = (shown) => {
  const removed = comparisonForm(shown);
  const spaced = comparisonForm(shown.replace(HANGUL_FILLER, " "));
  return spaced === removed ? [removed] : [removed, spaced];
};
function tagCollisions(peers, looks) {
  const out = /* @__PURE__ */ new Set();
  const groups = /* @__PURE__ */ new Map();
  const join4 = (key, p) => {
    const g = groups.get(key);
    if (g === void 0) groups.set(key, [p]);
    else g.push(p);
  };
  for (const [p, { display }] of peers) {
    const look = looks.get(p) ?? lookOf(p);
    join4(`look:${look.hue}:${look.accessory}`, p);
    const shown = shownName(display);
    if (shown === null) continue;
    for (const key of nameKeys(shown)) {
      if (HANDLE_LOOKALIKE.test(key)) out.add(p);
      join4(`name:${key}`, p);
    }
    for (const key of nameKeys(cap(shown, "name"))) join4(`tag:${key}`, p);
  }
  for (const g of groups.values()) if (g.length > 1) for (const p of g) out.add(p);
  return out;
}
var pos = (p) => [p.height, p.sub, p.k];
var posOrNull = (p) => p === null ? null : pos(p);
var actorVM = (a, h) => "peer" in a ? { peer: h.peer(a.peer) } : { seat: h.seat(a.seat) };
var actorOrNull = (a, h) => a === null ? null : actorVM(a, h);
var lineVM = (l, h) => "actor" in l ? { actor: actorVM(l.actor, h) } : { claimId: h.shortId(l.claimId) };
var labelVM = (l) => l === null ? null : { simple: vizText("label", l.simple), qualname: vizText("label", l.qualname) };
var noteVM = (n) => n === null ? null : vizText("note", n);
var linesVM = (l) => l === null ? null : [l[0], l[1]];
var byKey = (entries) => entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
var badgeCode = (a, code) => vizCode("peer" in a ? HEALTH_REASON_CODES : SS_CODES, code, null);
function projectEvent(e, h) {
  const at = pos(e);
  const seed = e.seed;
  switch (e.kind) {
    case "room_open":
      return { at, seed, kind: e.kind };
    case "room_sign":
      return { at, seed, kind: e.kind, sign: e.sign };
    case "room_badge":
      return { at, seed, kind: e.kind, level: e.level };
    case "person_enter":
    case "person_respawn":
    case "person_exit":
    case "person_thaw":
    case "person_absent":
    case "person_ghost":
    case "person_unghost":
      return { at, seed, kind: e.kind, peer: h.peer(e.peer) };
    case "person_freeze":
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), reasonCode: vizCode(FREEZE_REASON_CODES, e.reasonCode, "?") };
    case "person_slowed":
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), until: e.until };
    case "person_bang":
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), bang: e.bang };
    case "person_badge":
      return { at, seed, kind: e.kind, actor: actorVM(e.actor, h), badge: e.badge, on: e.on, code: badgeCode(e.actor, e.code) };
    case "pet_spawn":
    case "pet_poof":
      return { at, seed, kind: e.kind, seat: h.seat(e.seat), owner: h.peer(e.owner) };
    case "pose_relaxed":
      return { at, seed, kind: e.kind, actor: actorVM(e.actor, h) };
    case "publish":
      return {
        at,
        seed,
        kind: e.kind,
        actor: actorVM(e.actor, h),
        target: e.target,
        others: [...e.others],
        paths: servedPaths(e.paths),
        n: e.n,
        state: e.state,
        checks: e.checks,
        origin: e.origin
      };
    case "conflict":
      return {
        at,
        seed,
        kind: e.kind,
        conflict: e.conflict,
        source: e.source,
        on: actorVM(e.on, h),
        desk: e.desk,
        holdId: e.holdId === null ? null : h.shortId(e.holdId),
        cid: e.cid,
        eventKind: vizCode(EVENT_KINDS, e.eventKind, null),
        line: e.line === null ? null : lineVM(e.line, h)
      };
    case "box":
      return {
        at,
        seed,
        kind: e.kind,
        holdId: h.shortId(e.holdId),
        owner: actorVM(e.owner, h),
        holdKind: vizCode(HOLD_KINDS, e.holdKind, "?"),
        residence: vizCode(HOLD_RESIDENCES, e.residence, "?"),
        state: vizCode(HOLD_STATES, e.state, "?"),
        offer: vizCode(HOLD_OFFERS, e.offer, "?"),
        desk: e.desk,
        localOnly: e.localOnly,
        terminal: e.terminal
      };
    case "claim_take":
    case "claim_move":
      return {
        at,
        seed,
        kind: e.kind,
        claimId: h.shortId(e.claimId),
        seat: h.seat(e.seat),
        desk: e.desk,
        order: e.order,
        label: labelVM(e.label),
        granularity: e.granularity,
        lines: linesVM(e.lines),
        otherRules: e.otherRules
      };
    case "claim_stale":
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId) };
    case "claim_release":
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId), reason: e.reason };
    case "claim_reserve":
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId), request: e.request, requester: actorVM(e.requester, h) };
    case "grant_start":
    case "grant_end":
      return { at, seed, kind: e.kind, claimId: h.shortId(e.claimId), grantee: actorVM(e.grantee, h) };
    case "request_open":
      return {
        at,
        seed,
        kind: e.kind,
        request: e.request,
        from: actorVM(e.from, h),
        holder: actorVM(e.holder, h),
        desk: e.desk,
        requestKind: e.requestKind,
        estMinutes: e.estMinutes,
        attempt: e.attempt,
        note: noteVM(e.note)
      };
    case "request_status":
      return { at, seed, kind: e.kind, request: e.request, holder: actorVM(e.holder, h), status: e.status };
    case "answer":
      return { at, seed, kind: e.kind, request: e.request, holder: actorVM(e.holder, h), verb: e.verb, by: e.by, note: noteVM(e.note) };
    case "note": {
      const t = e.target;
      const target = t === null ? null : "claimId" in t ? { claimId: h.shortId(t.claimId) } : { request: t.request };
      return { at, seed, kind: e.kind, actor: actorVM(e.actor, h), target, text: vizText("note", e.text) };
    }
    case "save":
      return { at, seed, kind: e.kind, peer: h.peer(e.peer), desks: [...e.desks] };
  }
}
function placeVM(p, h) {
  switch (p.at) {
    case "home":
      return { at: "home", spot: p.spot };
    case "chair":
    case "stool":
    case "beside":
      return { at: p.at, desk: p.desk };
    case "visitor":
      return { at: "visitor", desk: p.desk, tile: p.tile };
    case "facing":
      return { at: "facing", actor: actorVM(p.actor, h), desk: p.desk };
    case "behind":
      return { at: "behind", peer: h.peer(p.peer) };
  }
}
var stateVM = (s, h) => ({
  place: placeVM(s.place, h),
  pose: s.pose,
  lastPublish: posOrNull(s.lastPublish),
  lastDesk: s.lastDesk,
  lastClaimOp: posOrNull(s.lastClaimOp)
});
function projectScene(s, h) {
  return {
    at: pos(s.at),
    badge: s.badge,
    branchMovedAt: s.branchMovedAt,
    characters: byKey([...s.characters].map(([p, c]) => [h.peer(p), {
      ...stateVM(c, h),
      ghost: c.ghost,
      absent: c.absent,
      frozen: c.frozen === null ? null : vizCode(FREEZE_REASON_CODES, c.frozen, "?"),
      slowedUntil: c.slowedUntil,
      rules: c.rules,
      credit: c.credit
    }])),
    pets: byKey([...s.pets].map(([seat, p]) => [h.seat(seat), {
      ...stateVM(p, h),
      owner: h.peer(p.owner),
      variant: p.variant,
      live: p.live,
      ssCode: vizCode(SS_CODES, p.ssCode, null)
    }])),
    desks: [...s.desks].map(([d, ds]) => [d, {
      lastEvent: ds.lastEvent,
      chair: actorOrNull(ds.chair, h),
      visitors: ds.visitors.map((a) => actorVM(a, h)),
      more: ds.more,
      claims: ds.claims.map((id) => h.shortId(id))
    }]).sort(([a], [b]) => a - b),
    claims: byKey([...s.claims].map(([id, c]) => [h.shortId(id), {
      seat: h.seat(c.seat),
      desk: c.desk,
      order: c.order,
      label: labelVM(c.label),
      granularity: c.granularity,
      lines: linesVM(c.lines),
      stale: c.stale,
      reservedFor: c.reservedFor,
      grantee: actorOrNull(c.grantee, h),
      otherRules: c.otherRules,
      at: pos(c.at)
    }])),
    requests: byKey([...s.requests].map(([id, r]) => [id, {
      from: actorVM(r.from, h),
      holder: actorVM(r.holder, h),
      desk: r.desk,
      status: vizCode(REQUEST_STATUSES, r.status, null)
    }])),
    boxes: byKey([...s.boxes].map(([id, b]) => [h.shortId(id), {
      owner: actorVM(b.owner, h),
      desk: b.desk,
      holdKind: vizCode(HOLD_KINDS, b.holdKind, "?"),
      residence: vizCode(HOLD_RESIDENCES, b.residence, "?"),
      state: vizCode(HOLD_STATES, b.state, "?"),
      localOnly: b.localOnly
    }])),
    bangs: byKey([...s.bangs].map(([id, b]) => [h.shortId(id), { on: actorVM(b.on, h), desk: b.desk }])),
    beat: s.beat.map((e) => projectEvent(e, h))
  };
}
var DISPLAY_ID_KEPT = /^[RC][0-9A-HJKMNP-TV-Z]{8}$/;
function projectCard(c, nowMono, h) {
  const k = c.card;
  const detailSets = DETAIL_SETS.get(k.code) ?? [];
  return {
    id: k.id,
    at: pos(k.at),
    group: k.group,
    code: k.code,
    actor: actorOrNull(k.actor, h),
    target: actorOrNull(k.target, h),
    paths: servedPaths(k.paths),
    n: k.n,
    desks: [...k.desks],
    displayId: k.displayId === null ? null : DISPLAY_ID_KEPT.test(k.displayId) ? k.displayId : h.shortId(k.displayId),
    parent: k.parent,
    label: k.label === null ? null : vizText("label", k.label),
    text: noteVM(k.text),
    detail: k.detail === null ? null : detailSets.some((s) => s.has(k.detail)) ? k.detail : "?",
    seen_ms: c.foldedAt === null ? null : Math.max(0, nowMono - c.foldedAt)
  };
}
var unescapeKey = (key) => key.split("/").map((seg) => seg.startsWith(":") ? seg.slice(1) : seg).join("/");
var zoneVM = (z) => ({ index: z.index, sign: vizText("sign", unescapeKey(z.key)), cells: [...z.cells] });
function deskVM(d) {
  const plaque = plaqueOf(d);
  return {
    ordinal: d.ordinal,
    kind: d.kind,
    zone: d.zone,
    cell: d.cell,
    slot: d.slot,
    plaque: plaque === null ? null : vizText("plaque", plaque),
    path: d.path === null ? null : vizText("path", d.path),
    lockbox: d.lockbox,
    first: d.first
  };
}
function projectLayout(l, h) {
  return { version: l.version, zones: l.zones.map(zoneVM), desks: l.desks.map(deskVM), homeOrder: l.homeOrder.map((p) => h.peer(p)) };
}
function projectLayoutDelta(d, h) {
  return { from_version: d.fromVersion, version: d.version, zones: d.zones.map(zoneVM), desks: d.desks.map(deskVM), homeOrder: d.homeOrder.map((p) => h.peer(p)) };
}
function projectOverlay(o, h) {
  if (o === null) return null;
  return {
    state: vizCode(STATUS_STATES, o.state, "?"),
    freeze_reasons: o.freezeReasons.filter((r) => FREEZE_REASON_CODES.has(r)),
    publish_pause: vizCode(PUBLISH_PAUSE_CODES, o.publishPause, null),
    down: o.down,
    unreadable: o.unreadable,
    offline_min: o.offlineMin === null || !Number.isFinite(o.offlineMin) ? null : Math.max(0, Math.floor(o.offlineMin)),
    holds: o.holds,
    incoming: o.incoming,
    ready: o.ready,
    you: o.you === null ? null : h.peer(o.you)
  };
}
function characterBadges(c) {
  if (c === void 0) return [];
  const on = [];
  if (c.rules) on.push("UI_VIZ_BADGE_RULES");
  if (c.credit) on.push("UI_VIZ_BADGE_CREDIT");
  return on.filter((b) => CHARACTER_BADGES.has(b));
}
function projectCharacters(room, only, h) {
  const collide = tagCollisions(room.peers, room.looks);
  const out = [];
  for (const [p, info] of room.peers) {
    if (only !== null && !only.has(p)) continue;
    const handle = h.peer(p);
    const look = room.looks.get(p) ?? lookOf(p);
    const c = room.scene?.characters.get(p);
    out.push({
      handle,
      name: nameTag(info.display, handle, collide.has(p)),
      hue: look.hue,
      accessory: look.accessory,
      ph: vizCode(PH_CODES, phOf(c, info.status, room.at), null),
      version: vizText("version", info.pluginVersion),
      badges: characterBadges(c)
    });
  }
  return out.sort((a, b) => a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);
}
function projectPets(pets, h) {
  return [...pets].map(([s, p]) => ({ seat: h.seat(s), owner: h.peer(p.owner), live: p.live, ss: vizCode(SS_CODES, p.ssCode, null), variant: p.variant })).sort((a, b) => a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0);
}
var ticksVM = (ticks) => ticks.map((t) => ({ h: t.h, glyph: t.glyph }));
function projectRoomHeader(m) {
  return {
    room_id: m.spec.id,
    label: vizText("room", m.spec.label),
    branch: vizText("branch", m.spec.branch),
    gone: m.gone,
    badges: m.badges.filter((b) => ROOM_BADGES.has(b)),
    unknown: m.unknown
  };
}
function projectRoom(m, nowMono, h) {
  return {
    ...projectRoomHeader(m),
    window: { h0: m.window.h0, h1: m.window.h1 },
    overlay: projectOverlay(m.overlay, h),
    layout: projectLayout(m.layout, h),
    looks: byKey([...m.looks].map(([p, l]) => [h.peer(p), { hue: l.hue, accessory: l.accessory }])),
    characters: projectCharacters({ peers: m.peers, looks: m.looks, scene: m.scene, at: m.scene.at }, null, h),
    pets: projectPets(m.pets, h),
    scene: projectScene(m.scene, h),
    cards: m.cards.map((c) => projectCard(c, nowMono, h)),
    ticks: ticksVM(m.ticks)
  };
}
function projectDelta(d, nowMono, h) {
  const out = [];
  if (d.layout !== null) out.push({ type: "layout", room_id: d.roomId, layout: projectLayoutDelta(d.layout, h) });
  const at = d.scene?.at ?? { height: d.window.h1, sub: 0, k: 0 };
  const characters = projectCharacters({ peers: d.peers, looks: new Map([...d.peers.keys()].map((p) => [p, lookOf(p)])), scene: d.scene, at }, null, h);
  const pets = projectPets(d.pets, h);
  const cards = d.cards.map((c) => projectCard(c, nowMono, h));
  const ticks = ticksVM(d.ticks);
  if (d.kind === "timeline") {
    out.push({ type: "timeline", room_id: d.roomId, h1: d.window.h1, events: d.events.map((e) => projectEvent(e, h)), cards, ticks, characters, pets });
  } else {
    if (d.scene === null) throw new TypeError("projectDelta: a snapshot delta carries the scene at its tip");
    out.push({ type: "room_snapshot", room_id: d.roomId, window: { h0: d.window.h0, h1: d.window.h1 }, scene: projectScene(d.scene, h), cards, ticks, characters, pets });
  }
  return out;
}
function projectPage(p, nowMono, h) {
  return {
    room_id: p.roomId,
    from: p.from,
    to: p.to,
    scene: projectScene(p.scene, h),
    events: p.events.map((e) => projectEvent(e, h)),
    cards: p.cards.map((c) => projectCard(c, nowMono, h)),
    layout: p.layout === null ? null : projectLayoutDelta(p.layout, h)
  };
}
function projectWorld(rooms, cursor, demo, captions, nowMono, h) {
  const served = rooms.map((m) => projectRoom(demo ? { ...m, overlay: null } : m, nowMono, h));
  const ids = new Set(served.map((r) => r.room_id));
  const caps = !demo ? [] : captions.filter((c) => ids.has(c.room)).map((c) => ({
    room_id: c.room,
    height: c.height,
    code: vizCode(CAPTION_CODES, c.code, null),
    text: c.text === null ? null : vizText("caption", c.text)
  }));
  return { v: 1, cursor, demo, rooms: served, captions: caps };
}

// src/viz/server/vizLog.ts
import path from "node:path";

// src/viz/server/clockTimer.ts
var MAX_TIMER_MS = 2147483647;
function clockTimer(clock, ms, fn) {
  const due = clock.monoMs() + ms;
  let live = true;
  let handle = null;
  const wake = () => {
    handle = null;
    if (!live) return;
    const left = due - clock.monoMs();
    if (left > 0) {
      handle = setTimeout(() => {
        wake();
      }, Math.min(Math.ceil(left), MAX_TIMER_MS));
      handle.unref();
      return;
    }
    live = false;
    fn();
  };
  handle = setTimeout(() => {
    wake();
  }, Math.min(Math.max(1, Math.ceil(ms)), MAX_TIMER_MS));
  handle.unref();
  return {
    cancel: () => {
      live = false;
      if (handle !== null) clearTimeout(handle);
      handle = null;
    }
  };
}

// src/viz/server/vizLog.ts
var LOG_ROTATE_BYTES = 1e7;
var LOG_FILES = 5;
var LOG_KEEP_MS = 12096e5;
var SEC_WINDOW_MS = 6e4;
var INSTANCE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
var ROOM_ID_RE = /^r[0-9A-HJKMNP-TV-Z]{8}$/;
var ERRNO_RE = /^E[A-Z0-9]{2,15}$/;
var ERROR_CODE_RE = /^(E[A-Z0-9]{2,15}|ERR_[A-Z0-9_]{1,60}|HPE_[A-Z0-9_]{1,40})$/;
var KEY_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
var RESERVED_KEYS = /* @__PURE__ */ new Set(["t", "code"]);
var LOG_FILE_RE = /^viz-.*\.jsonl$/;
var MAX_FRAMES = 20;
var FN_MAX = 128;
var DROPPED_CODE = "VIZ_LOG_DROPPED";
function isRegistryCode(s) {
  return ALL_VIZ_CODES.has(s) || REASON_CODES.has(s);
}
function refuse2(what) {
  throw new TypeError(`vizLog: ${what} is not allowed in a log line`);
}
function checkCode(code) {
  if (typeof code !== "string" || !isRegistryCode(code) || code === DROPPED_CODE) refuse2("the code");
}
function checkParam(key, v) {
  if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) refuse2("a parameter name");
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) refuse2("a non-finite number");
    return v;
  }
  if (typeof v === "string" && (isRegistryCode(v) || ROOM_ID_RE.test(v) || ERRNO_RE.test(v))) return v;
  return refuse2("a parameter value");
}
function lineOf(t, code, params) {
  checkCode(code);
  const line = { t, code };
  if (params !== void 0) for (const [k, v] of Object.entries(params)) line[k] = checkParam(k, v);
  return line;
}
function errorCodeOf(err) {
  const c = typeof err === "object" && err !== null ? err.code : void 0;
  return typeof c === "string" && ERROR_CODE_RE.test(c) ? c : null;
}
var FRAME_RE = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/;
var FN_UNSAFE = /[^\p{L}\p{N}_$.<>[\] ]/gu;
var BASENAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function basename(file) {
  const b = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  return BASENAME_RE.test(b) ? b : "?";
}
function stackFrames(err) {
  if (!(err instanceof Error) || typeof err.stack !== "string") return [];
  const header = Error.prototype.toString.call(err);
  if (!err.stack.startsWith(header) || err.stack.length > header.length && err.stack[header.length] !== "\n") return [];
  const out = [];
  for (const text of err.stack.slice(header.length).split("\n")) {
    if (out.length === MAX_FRAMES) break;
    const m = FRAME_RE.exec(text);
    if (m === null) continue;
    const name = (m[1] ?? "").replace(FN_UNSAFE, "?").slice(0, FN_MAX);
    const fn = name === "" ? `(${basename(m[2] ?? "")})` : `${name} (${basename(m[2] ?? "")})`;
    out.push({ fn, line: Number(m[3]), col: Number(m[4]) });
  }
  return out;
}
function lineBytes(line) {
  return Buffer.from(`${sanitize(JSON.stringify(line), "log")}
`, "utf8");
}
function fileName(instance, n) {
  return `viz-${instance}-${n}.jsonl`;
}
function hasCode2(e, code) {
  return typeof e === "object" && e !== null && e.code === code;
}
var STAGED = 0;
var SHIFT = [
  ...Array.from({ length: LOG_FILES - 2 }, (_, i) => [LOG_FILES - 1 - i, LOG_FILES - i]),
  [STAGED, 2]
];
var LOG_HOLD_BYTES = 2 * LOG_ROTATE_BYTES;
var FileVizLog = class {
  constructor(fs, clock, dir, instance, size2) {
    this.fs = fs;
    this.clock = clock;
    this.dir = dir;
    this.instance = instance;
    this.size = size2;
  }
  sec = /* @__PURE__ */ new Map();
  queue = Promise.resolve();
  /** The next SHIFT step of a rotation that stopped at a failed rename; null when no rotation is pending. */
  shiftAt = null;
  /** Lines dropped since -1 reached LOG_HOLD_BYTES (R-V67); written as one VIZ_LOG_DROPPED marker once the rotation resumes. */
  dropped = 0;
  write(code, params) {
    this.enqueue(lineOf(this.now(), code, params));
  }
  security(code) {
    const now = this.now();
    if (code === "SEC_VIZ_LAUNCH_REUSED") {
      this.enqueue({ ...lineOf(now, code, void 0), count: 1 });
      return;
    }
    const open = this.sec.get(code);
    if (open !== void 0 && now - open.start < SEC_WINDOW_MS) {
      open.count += 1;
      return;
    }
    if (open !== void 0) this.closeWindow(code, open);
    const w = { start: now, count: 1, timer: clockTimer(this.clock, SEC_WINDOW_MS, () => this.closeWindow(code, w)) };
    this.sec.set(code, w);
  }
  error(code, err) {
    this.enqueue({ ...lineOf(this.now(), code, void 0), err: errorCodeOf(err), frames: stackFrames(err) });
  }
  async flush() {
    for (const [code, w] of [...this.sec]) this.closeWindow(code, w);
    await this.queue;
  }
  /** Writes a window's one line and forgets it; a window already closed (a stale timer) writes nothing. */
  closeWindow(code, w) {
    if (this.sec.get(code) !== w) return;
    w.timer.cancel();
    this.sec.delete(code);
    this.enqueue({ ...lineOf(w.start, code, void 0), count: w.count });
  }
  now() {
    return Math.round(this.clock.monoMs());
  }
  enqueue(line) {
    const bytes2 = lineBytes(line);
    this.queue = this.queue.then(() => this.append(bytes2)).catch(() => void 0);
  }
  file(n) {
    return path.join(this.dir, fileName(this.instance, n));
  }
  /** A pending shift resumes first; a line that would pass 10 MB rotates first. Whatever the rotation's outcome, the line is appended
   *  to -1 — past 10 MB while the rotation or the shift is blocked, and the next line past the limit retries — up to LOG_HOLD_BYTES
   *  (R-V67). Past that, lines are dropped and counted until a rotation empties -1; the first line written then is preceded, in the
   *  same append, by one VIZ_LOG_DROPPED{n} marker. */
  async append(bytes2) {
    if (this.shiftAt !== null) await this.shift();
    if (this.shiftAt === null && this.size > 0 && this.size + bytes2.length > LOG_ROTATE_BYTES) await this.rotate();
    const out = this.dropped > 0 ? Buffer.concat([lineBytes({ t: this.now(), code: DROPPED_CODE, n: this.dropped }), bytes2]) : bytes2;
    if (this.dropped > 0 && this.size > LOG_ROTATE_BYTES || this.size + out.length > LOG_HOLD_BYTES) {
      this.dropped += 1;
      return;
    }
    await this.fs.appendFile(this.file(1), out);
    this.size += out.length;
    this.dropped = 0;
  }
  /** -1 is first renamed to the staging name; only then are the archives shifted (SHIFT), so a -1 held by another process (the
   *  rename fails: on Windows a rename of a file another process holds open fails, W3) skips the rotation with no archive renamed or
   *  deleted. Only this instance's files are named. */
  async rotate() {
    try {
      await this.fs.rename(this.file(1), this.file(STAGED));
    } catch (e) {
      if (hasCode2(e, "ENOENT")) this.size = 0;
      return;
    }
    this.size = 0;
    this.shiftAt = 0;
    await this.shift();
  }
  /** Runs the pending SHIFT from its next step; a rename that fails (other than ENOENT: nothing to move) stops it at that step. */
  async shift() {
    while (this.shiftAt !== null && this.shiftAt < SHIFT.length) {
      const [from, to] = SHIFT[this.shiftAt];
      try {
        await this.fs.rename(this.file(from), this.file(to));
      } catch (e) {
        if (!hasCode2(e, "ENOENT")) return;
      }
      this.shiftAt += 1;
    }
    this.shiftAt = null;
  }
};
async function openVizLog(o) {
  if (!INSTANCE_RE.test(o.instance)) refuse2("the instance id");
  await o.fs.mkdirp(o.dir, 448);
  const current = await o.fs.lstat(path.join(o.dir, fileName(o.instance, 1)));
  return new FileVizLog(o.fs, o.clock, o.dir, o.instance, current?.isFile === true ? current.size : 0);
}
async function cleanupVizLogs(fs, clock, dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (hasCode2(e, "ENOENT") || hasCode2(e, "ENOTDIR")) return 0;
    throw e;
  }
  let deleted = 0;
  for (const name of names) {
    if (!LOG_FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = await fs.lstat(file);
    } catch {
      continue;
    }
    if (st === null || !st.isFile) continue;
    if (clock.wallMs() - Number(st.mtimeNs / 1000000n) <= LOG_KEEP_MS) continue;
    try {
      await fs.unlink(file);
      deleted += 1;
    } catch {
    }
  }
  return deleted;
}
var nullVizLog = Object.freeze({
  write(code, params) {
    lineOf(0, code, params);
  },
  security() {
  },
  error(code) {
    checkCode(code);
  },
  flush: async () => {
  }
});

// src/viz/server/api.ts
var WORLD_MS = 2500;
var STATE = /* @__PURE__ */ new WeakMap();
function internals(api) {
  const st = STATE.get(api);
  if (st === void 0) throw new TypeError("pollSinkFor: the api was not made by createWorldApi");
  return st;
}
function storeOf(st, roomId2) {
  for (const s of st.stores) {
    let id = st.ids.get(s);
    if (id === void 0 && st.ready.has(s)) {
      id = s.snapshot().spec.id;
      st.ids.set(s, id);
    }
    if (id === roomId2) return s;
  }
  return null;
}
function resetAll(st) {
  st.cache = null;
  st.hub.publish({ type: "reset" });
}
function pageStrings() {
  const templates = {};
  for (const code of [...PAGE_CODES].sort()) {
    const e = EN_VIZ[code];
    if (e !== void 0) templates[code] = structuredClone(e);
  }
  return { lang: "en", templates };
}
function createWorldApi(o) {
  const st = {
    stores: o.stores,
    handles: o.handles,
    hub: o.hub,
    clock: o.clock,
    demo: o.demo,
    ready: /* @__PURE__ */ new Set(),
    ids: /* @__PURE__ */ new Map(),
    cache: null,
    collide: /* @__PURE__ */ new Map()
  };
  for (const s of o.stores) void s.ready.then(() => {
    st.ready.add(s);
  }, () => {
  });
  const strings = pageStrings();
  const allReady = () => Promise.all(o.stores.map((s) => s.ready)).then(() => void 0);
  const compute = async (entry) => {
    await allReady();
    const models = o.stores.map((s) => s.snapshot());
    o.stores.forEach((s, i) => st.ids.set(s, models[i].spec.id));
    entry.at = o.clock.monoMs();
    for (; ; ) {
      const world = projectWorld(models, o.hub.seq(), o.demo, o.captions, o.clock.monoMs(), o.handles);
      if (!o.handles.takeCollision()) {
        for (const m of models) st.collide.set(m.spec.id, tagCollisions(m.peers, m.looks));
        return world;
      }
      o.hub.publish({ type: "reset" });
    }
  };
  const api = {
    world() {
      const c = st.cache;
      if (c !== null && (c.at === null || o.clock.monoMs() - c.at < WORLD_MS)) return c.world;
      const pending = { at: null };
      const entry = Object.assign(pending, { world: compute(pending) });
      st.cache = entry;
      entry.world.catch(() => {
        if (st.cache === entry) st.cache = null;
      });
      return entry.world;
    },
    async page(roomId2, from, to) {
      await allReady();
      const store = storeOf(st, roomId2);
      if (store === null) return null;
      const m = await store.page(from, to);
      if (m === null) return null;
      let p = projectPage(m, o.clock.monoMs(), o.handles);
      if (o.handles.takeCollision()) {
        resetAll(st);
        p = projectPage(m, o.clock.monoMs(), o.handles);
      }
      if (p.layout !== null) o.hub.publish({ type: "layout", room_id: p.room_id, layout: p.layout });
      return p;
    },
    strings(lang) {
      return LANGS.includes(lang) ? strings : null;
    }
  };
  STATE.set(api, st);
  return api;
}
function pollSinkFor(api, hub, handles, clock, log = nullVizLog) {
  const st = internals(api);
  const logged = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (e) {
      try {
        log.error("UI_INTERNAL_ERROR", e);
      } catch {
      }
      throw e;
    }
  };
  const withRoom = (d, payloads) => {
    const store = storeOf(st, d.roomId);
    if (store === null) return payloads;
    const m = store.snapshot();
    const collide = tagCollisions(m.peers, m.looks);
    const prev = st.collide.get(d.roomId);
    st.collide.set(d.roomId, collide);
    const only = new Set(d.peers.keys());
    if (prev !== void 0) {
      for (const p of collide) if (!prev.has(p)) only.add(p);
      for (const p of prev) if (!collide.has(p)) only.add(p);
    }
    const characters = projectCharacters({ peers: m.peers, looks: m.looks, scene: m.scene, at: m.scene.at }, only, handles);
    return payloads.map((p) => p.type === "timeline" || p.type === "room_snapshot" ? { ...p, characters } : p);
  };
  const publishAll = (payloads) => {
    if (handles.takeCollision()) {
      resetAll(st);
      return;
    }
    for (const p of payloads) hub.publish(p);
  };
  return {
    delta: logged((d) => {
      publishAll(withRoom(d, projectDelta(d, clock.monoMs(), handles)));
    }),
    overlay: logged((roomId2, ov) => {
      if (st.demo) return;
      const overlay = projectOverlay(ov, handles);
      if (overlay !== null) publishAll([{ type: "overlay", room_id: roomId2, overlay }]);
    }),
    roomChanged: logged((roomId2) => {
      const store = storeOf(st, roomId2);
      if (store === null) return;
      const r = projectRoomHeader(store.snapshot());
      publishAll([{ type: "room", room_id: r.room_id, change: "state", label: r.label, branch: r.branch, gone: r.gone, badges: r.badges, unknown: r.unknown }]);
    }),
    reset: logged(() => {
      resetAll(st);
    })
  };
}

// src/viz/server/http.ts
import http from "node:http";

// src/viz/server/shell.ts
var SHELL_HTML = '<!doctype html><html><head><meta charset="utf-8"><title></title><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head><body><main id="app"></main></body></html>';
function staticRoute(path2, a) {
  switch (path2) {
    case "/":
      return { type: "text/html; charset=utf-8", body: SHELL_HTML };
    case "/app.js":
      return { type: "text/javascript; charset=utf-8", body: a.appJs };
    case "/app.css":
      return { type: "text/css; charset=utf-8", body: a.appCss };
    case "/favicon.ico":
      return "favicon";
    default:
      return null;
  }
}

// src/viz/server/http.ts
var CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'"
].join("; ");
var SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), clipboard-read=(), payment=()",
  "X-DNS-Prefetch-Control": "off",
  "Cache-Control": "no-store"
});
var HTTP_LIMITS = Object.freeze({
  maxHeaderSize: 8192,
  maxUrl: 2048,
  headersTimeout: 5e3,
  requestTimeout: 1e4,
  keepAliveTimeout: 5e3,
  connectionsCheckingInterval: 1e3,
  maxConnections: 32,
  maxSessionBody: 256
});
var REAP_MS = 1e3;
var SSE_RECHECK_MS = 1e3;
function cappedSink(res, clock, log) {
  let ended = false;
  let checkQueued = false;
  let overOnce = false;
  let recheck = null;
  const clearOver = () => {
    overOnce = false;
    recheck?.cancel();
    recheck = null;
  };
  const measure = () => {
    if (ended) return;
    if (res.writableLength <= SSE_BUFFER_MAX) {
      clearOver();
      return;
    }
    if (!overOnce) {
      overOnce = true;
      recheck = clockTimer(clock, SSE_RECHECK_MS, () => {
        recheck = null;
        measure();
      });
      return;
    }
    clearOver();
    ended = true;
    log.security("SEC_VIZ_LIMIT");
    res.destroy();
  };
  const check2 = () => {
    checkQueued = false;
    measure();
  };
  res.on("drain", clearOver);
  res.once("close", () => {
    ended = true;
    clearOver();
  });
  return {
    write: (chunk) => {
      if (ended) return false;
      const ok = res.write(chunk);
      if (!checkQueued) {
        checkQueued = true;
        setImmediate(check2);
      }
      return ok;
    },
    end: () => {
      if (ended) return;
      ended = true;
      res.end();
    },
    onClose: (cb) => {
      res.once("close", cb);
    }
  };
}
var JSON_TYPE = "application/json; charset=utf-8";
var TEXT_TYPE = "text/plain; charset=utf-8";
var SSE_TYPE = "text/event-stream; charset=utf-8";
var SESSION_PATH = "/api/v1/session";
var TIMELINE_RE = /^\/api\/v1\/rooms\/(r[0-9A-HJKMNP-TV-Z]{8})\/timeline$/;
var HEIGHT_RE = /^(0|[1-9][0-9]{0,9})$/;
var LOOPBACK_RE = /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
function rawResponse(status, reason) {
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) lines.push(`${k}: ${v}`);
  lines.push(`Content-Type: ${TEXT_TYPE}`, "Content-Length: 0", "Connection: close", "", "");
  return lines.join("\r\n");
}
var RAW_400 = rawResponse(400, "Bad Request");
var RAW_408 = rawResponse(408, "Request Timeout");
var RAW_431 = rawResponse(431, "Request Header Fields Too Large");
function headerValues(req, name) {
  const out = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) out.push(req.rawHeaders[i + 1]);
  }
  return out;
}
function single(req, name) {
  const v = headerValues(req, name);
  return v.length === 1 ? v[0] : void 0;
}
function queryParams(query, keys) {
  if (query === null) return null;
  const out = /* @__PURE__ */ new Map();
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const k = part.slice(0, eq);
    if (!keys.includes(k) || out.has(k)) return null;
    out.set(k, part.slice(eq + 1));
  }
  return out.size === keys.length ? out : null;
}
var refusal = (status, code, sec, close = true) => ({ status, code, sec, close });
async function createServer(deps) {
  const { clock, log, hub, tokens, api } = deps;
  const server = http.createServer({
    requireHostHeader: false,
    insecureHTTPParser: false,
    maxHeaderSize: HTTP_LIMITS.maxHeaderSize,
    headersTimeout: HTTP_LIMITS.headersTimeout,
    requestTimeout: HTTP_LIMITS.requestTimeout,
    keepAliveTimeout: HTTP_LIMITS.keepAliveTimeout,
    connectionsCheckingInterval: HTTP_LIMITS.connectionsCheckingInterval
  });
  server.headersTimeout = HTTP_LIMITS.headersTimeout;
  server.requestTimeout = HTTP_LIMITS.requestTimeout;
  server.keepAliveTimeout = HTTP_LIMITS.keepAliveTimeout;
  server.maxConnections = HTTP_LIMITS.maxConnections;
  let host = "";
  let origin = "";
  const inFlight = /* @__PURE__ */ new WeakMap();
  const waitingForBody = /* @__PURE__ */ new WeakMap();
  const reaps = /* @__PURE__ */ new Set();
  const reap = (socket) => {
    socket.resume();
    const t = clockTimer(clock, REAP_MS, () => {
      reaps.delete(t);
      socket.destroy();
    });
    reaps.add(t);
    socket.once("close", () => {
      t.cancel();
      reaps.delete(t);
    });
  };
  const send = (res, status, type, body, close) => {
    const buf = Buffer.from(body, "utf8");
    const length = status === 204 ? {} : { "Content-Length": String(buf.length) };
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...length, ...close ? { Connection: "close" } : {} });
    res.end(status === 204 ? void 0 : buf);
  };
  const sendJson = (res, status, value, close = false) => send(res, status, JSON_TYPE, escapeJson(value), close);
  const refuse4 = (res, r) => {
    if (r.sec !== null) log.security(r.sec);
    if (r.code === null) send(res, r.status, TEXT_TYPE, "", r.close);
    else sendJson(res, r.status, { code: r.code }, r.close);
  };
  const admit2 = (req, path2) => {
    const hosts = headerValues(req, "host");
    if (hosts.length !== 1 || hosts[0] !== host) return refusal(421, "UI_VIZ_BAD_HOST", "SEC_VIZ_BAD_HOST");
    const isApi = path2.startsWith("/api/");
    const isSessionPost = req.method === "POST" && path2 === SESSION_PATH;
    const origins = headerValues(req, "origin");
    if (origins.length > 1 || origins.length === 1 && origins[0] !== origin || isSessionPost && origins.length === 0) {
      return refusal(403, null, "SEC_VIZ_BAD_ORIGIN");
    }
    const sites = headerValues(req, "sec-fetch-site");
    if (sites.length > 1) return refusal(403, null, "SEC_VIZ_BAD_ORIGIN");
    const site = sites[0];
    if (site !== void 0 && site !== "same-origin" && (isApi || site !== "none")) return refusal(403, null, "SEC_VIZ_BAD_ORIGIN");
    const methodOk = req.method === "GET" || req.method === "HEAD" || isSessionPost;
    if (!methodOk) return refusal(405, null, "SEC_VIZ_METHOD");
    const url = req.url ?? "";
    if (url.length > HTTP_LIMITS.maxUrl || !url.startsWith("/")) return refusal(400, null, "SEC_VIZ_LIMIT");
    const te = req.headers["transfer-encoding"];
    const cl = req.headers["content-length"];
    if (isSessionPost) {
      if (cl !== void 0 && Number(cl) > HTTP_LIMITS.maxSessionBody) return refusal(413, null, "SEC_VIZ_LIMIT");
    } else if (te !== void 0 || cl !== void 0 && cl !== "0") {
      return refusal(400, null, "SEC_VIZ_LIMIT");
    }
    if (!LOOPBACK_RE.test(req.socket.remoteAddress ?? "")) return "destroy";
    return null;
  };
  const readBody = (req) => new Promise((resolve) => {
    let size2 = 0;
    const done = (r) => {
      req.removeAllListeners("data");
      resolve(r);
    };
    req.on("data", (chunk) => {
      size2 += chunk.length;
      if (size2 > HTTP_LIMITS.maxSessionBody) done("too_large");
    });
    req.once("end", () => done("ok"));
    req.once("error", () => done("aborted"));
    req.once("close", () => done("aborted"));
  });
  const redeem = async (req, res) => {
    const socket = req.socket;
    waitingForBody.set(socket, res);
    const body = await readBody(req);
    if (waitingForBody.get(socket) === res) waitingForBody.delete(socket);
    if (body === "aborted" || res.headersSent) return;
    if (body === "too_large") return refuse4(res, refusal(413, null, "SEC_VIZ_LIMIT"));
    const r = tokens.redeem(single(req, "x-cowork-launch"));
    if (r.ok) {
      deps.onActivity();
      return sendJson(res, 200, { session: r.session, instance: r.instance });
    }
    if (r.why === "expired") return refuse4(res, refusal(401, "UI_VIZ_LINK_EXPIRED", "SEC_VIZ_LAUNCH_EXPIRED", false));
    if (r.why !== "reused") return refuse4(res, refusal(401, "UI_VIZ_NEED_LINK", "SEC_VIZ_BAD_TOKEN", false));
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      deps.onLaunchReused();
    };
    res.once("finish", tell);
    res.once("close", tell);
    sendJson(res, 401, { code: "UI_VIZ_LINK_REUSED" }, true);
    hub.close();
    log.security("SEC_VIZ_LAUNCH_REUSED");
  };
  const stream = (req, res) => {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": SSE_TYPE });
    res.flushHeaders();
    hub.attach(cappedSink(res, clock, log), single(req, "last-event-id"));
  };
  const notFound = (res) => sendJson(res, 404, { code: "UI_VIZ_NOT_FOUND" });
  const apiRow = (method, path2) => {
    if (method !== "GET") return null;
    if (path2 === "/api/v1/world") return { kind: "world" };
    if (path2 === "/api/v1/stream") return { kind: "stream" };
    if (path2 === "/api/v1/strings") return { kind: "strings" };
    const m = TIMELINE_RE.exec(path2);
    return m === null ? null : { kind: "timeline", room: m[1] };
  };
  const routeApi = async (req, res, row, query) => {
    if (!tokens.checkSession(single(req, "x-cowork-session"))) return refuse4(res, refusal(401, "UI_VIZ_NEED_LINK", "SEC_VIZ_BAD_TOKEN", false));
    deps.onActivity();
    switch (row.kind) {
      case "world":
        return query === null ? sendJson(res, 200, await api.world()) : notFound(res);
      case "stream":
        return query === null ? stream(req, res) : notFound(res);
      case "strings": {
        const q = queryParams(query, ["lang"]);
        if (q === null) return refuse4(res, refusal(400, null, null, false));
        const lang = q.get("lang");
        const strings = LANGS.includes(lang) ? api.strings(lang) : null;
        return strings === null ? notFound(res) : sendJson(res, 200, strings);
      }
      case "timeline": {
        const q = queryParams(query, ["from", "to"]);
        const from = q?.get("from");
        const to = q?.get("to");
        if (from === void 0 || to === void 0 || !HEIGHT_RE.test(from) || !HEIGHT_RE.test(to)) return refuse4(res, refusal(400, null, null, false));
        const page = await api.page(row.room, Number(from), Number(to));
        return page === null ? notFound(res) : sendJson(res, 200, page);
      }
    }
  };
  const route = async (req, res, path2, query) => {
    if (path2 === SESSION_PATH) return req.method === "POST" ? redeem(req, res) : notFound(res);
    if (path2.startsWith("/api/")) {
      const row = apiRow(req.method, path2);
      return row === null ? notFound(res) : routeApi(req, res, row, query);
    }
    const s = query === null ? staticRoute(path2, deps.assets) : null;
    if (s === null) return notFound(res);
    if (s === "favicon") return send(res, 204, TEXT_TYPE, "", false);
    return send(res, 200, s.type, s.body, false);
  };
  const handle = async (req, res, phase) => {
    res.sendDate = false;
    const socket = req.socket;
    inFlight.set(socket, res);
    res.once("close", () => {
      if (inFlight.get(socket) === res) inFlight.delete(socket);
    });
    try {
      if (req.headers.upgrade !== void 0) {
        log.security("SEC_VIZ_METHOD");
        req.socket.destroy();
        return;
      }
      const target = req.url ?? "";
      const q = target.indexOf("?");
      const path2 = q < 0 ? target : target.slice(0, q);
      const query = q < 0 ? null : target.slice(q + 1);
      const verdict = admit2(req, path2);
      if (verdict === "destroy") {
        req.socket.destroy();
        return;
      }
      if (verdict !== null) return refuse4(res, verdict);
      if (phase === "expectation") return send(res, 417, TEXT_TYPE, "", true);
      if (phase === "continue") res.writeContinue();
      await route(req, res, path2, query);
    } catch (err) {
      log.error("UI_INTERNAL_ERROR", err);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { code: "UI_INTERNAL_ERROR" }, true);
    }
  };
  server.on("request", (req, res) => {
    void handle(req, res, "request");
  });
  server.on("checkContinue", (req, res) => {
    void handle(req, res, "continue");
  });
  server.on("checkExpectation", (req, res) => {
    void handle(req, res, "expectation");
  });
  server.on("clientError", (err, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    const timeout = err.code === "ERR_HTTP_REQUEST_TIMEOUT";
    const waiting = waitingForBody.get(socket);
    if (timeout && waiting !== void 0 && !waiting.headersSent) {
      log.security("SEC_VIZ_LIMIT");
      send(waiting, 408, TEXT_TYPE, "", true);
      reap(socket);
      return;
    }
    if (inFlight.has(socket)) {
      socket.destroy();
      return;
    }
    if (!(timeout && socket.bytesRead === 0)) log.security("SEC_VIZ_LIMIT");
    socket.end(err.code === "HPE_HEADER_OVERFLOW" ? RAW_431 : timeout ? RAW_408 : RAW_400);
    reap(socket);
  });
  const destroy = (_req, socket) => {
    log.security("SEC_VIZ_METHOD");
    socket.destroy();
  };
  server.on("upgrade", destroy);
  server.on("connect", destroy);
  const closeServer = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  const bound = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve(true));
  });
  const a = bound ? server.address() : null;
  if (a === null || typeof a === "string" || a.address !== "127.0.0.1" || a.family !== "IPv4") {
    await closeServer();
    return { refuse: "RF_VIZ_BIND_FAILED" };
  }
  server.on("error", (err) => log.error("UI_INTERNAL_ERROR", err));
  const port = a.port;
  host = `127.0.0.1:${port}`;
  origin = `http://127.0.0.1:${port}`;
  let commentTimer;
  const comment = () => {
    hub.comment();
    commentTimer = clockTimer(clock, COMMENT_MS, comment);
  };
  commentTimer = clockTimer(clock, COMMENT_MS, comment);
  let closing = null;
  return {
    port,
    close: () => {
      if (closing === null) {
        commentTimer.cancel();
        for (const t of reaps) t.cancel();
        reaps.clear();
        closing = closeServer();
      }
      return closing;
    }
  };
}

// src/viz/server/poll.ts
var POLL_MS = 2500;
function startPoll(stores, sink, clock) {
  let stopped = false;
  let timer = null;
  let running = Promise.resolve();
  const ids = /* @__PURE__ */ new Map();
  const idOf = (s) => {
    let id = ids.get(s);
    if (id === void 0) {
      id = s.snapshot().spec.id;
      ids.set(s, id);
    }
    return id;
  };
  const report = (s, r) => {
    let failed = false;
    const call = (fn) => {
      try {
        fn();
        return true;
      } catch {
        failed = true;
        return false;
      }
    };
    const { overlay, delta, change } = r;
    if (overlay !== null) call(() => sink.overlay(idOf(s), overlay));
    if (delta !== null) call(() => sink.delta(delta));
    let reset = false;
    if (change === "rebuilt") reset = call(() => sink.reset());
    else if (change === "state") call(() => sink.roomChanged(idOf(s)));
    if (failed && !reset) call(() => sink.reset());
  };
  const pass = async () => {
    for (const s of stores) {
      if (stopped) return;
      let r;
      try {
        r = await s.tick();
      } catch {
        continue;
      }
      report(s, r);
    }
  };
  const arm = (ms) => {
    if (stopped) return;
    timer = clockTimer(clock, ms, () => {
      timer = null;
      const started = clock.monoMs();
      running = pass().then(() => arm(Math.max(0, started + POLL_MS - clock.monoMs())));
    });
  };
  arm(POLL_MS);
  return async () => {
    stopped = true;
    timer?.cancel();
    timer = null;
    await running;
  };
}

// src/git/oid.ts
var OidError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "OidError";
  }
};
var OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function parseOid(s) {
  const t = typeof s === "string" && s.endsWith("\n") ? s.slice(0, -1) : s;
  if (typeof t !== "string" || !OID_RE.test(t)) {
    const shown = typeof t === "string" ? JSON.stringify(t.length > 80 ? `${t.slice(0, 80)}...` : t) : typeof t;
    throw new OidError(`not an object id: ${shown}`);
  }
  return t;
}
function isOid(x) {
  return typeof x === "string" && OID_RE.test(x);
}

// src/board/boardCommit.ts
import { deflateSync, inflateSync } from "node:zlib";

// src/git/trailers.ts
var SKIP_SUBJECT_PREFIX = "[skip ci] ***NO_CI***";
var TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):(?: (.*))?$/;
function parseMessage(raw) {
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const subject = lines[0] ?? "";
  let start = lines.length;
  while (start > 0 && lines[start - 1] !== "") start--;
  const trailers = [];
  if (start > 0) {
    for (const line of lines.slice(start)) {
      const m = TRAILER_LINE.exec(line);
      if (m !== null) trailers.push({ key: m[1], value: m[2] ?? "" });
    }
  }
  return { subject, trailers };
}

// src/git/repo.ts
var GitCommandError = class extends Error {
  argv;
  code;
  stderrText;
  constructor(argv2, code, stderr) {
    const text = stderr.toString("utf8").trim();
    super(`git ${argv2.slice(0, 3).join(" ")} failed with exit code ${code}${text.length > 0 ? `: ${text.slice(0, 300)}` : ""}`);
    this.name = "GitCommandError";
    this.argv = [...argv2];
    this.code = code;
    this.stderrText = text;
  }
};
function headerOid(o, line, prefixLength, hexLength) {
  const hex = line.slice(prefixLength);
  if (hex.length !== hexLength || !/^[0-9a-fA-F]+$/.test(hex)) throw new OidError(`commit ${o}: malformed header line ${JSON.stringify(line.slice(0, 80))}`);
  return parseOid(Buffer.from(hex.toLowerCase(), "latin1").toString("latin1"));
}
function parseCommitObject(o, raw) {
  const split = raw.indexOf("\n\n");
  const header = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const lines = header.split("\n");
  const first = lines[0] ?? "";
  if (!first.startsWith("tree ")) throw new Error(`commit ${o} has no tree line`);
  const tree = headerOid(o, first, "tree ".length, o.length);
  const parents = [];
  for (let i = 1; i < lines.length && lines[i].startsWith("parent "); i++) parents.push(headerOid(o, lines[i], "parent ".length, o.length));
  const { subject, trailers } = parseMessage(message);
  return { oid: o, tree, parents, subject, trailers };
}

// src/board/canonicalJson.ts
var MAX_JSON_DEPTH = 64;
function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function write(v, out, open, depth) {
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(v)) throw new RangeError(`canonicalJson: non-finite number ${String(v)}`);
      out.push(JSON.stringify(v));
      return;
    case "string":
      out.push(JSON.stringify(v));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof v} is not JSON`);
  }
  const o = v;
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`canonicalJson: nesting deeper than ${MAX_JSON_DEPTH}`);
  if (open.has(o)) throw new TypeError("canonicalJson: cyclic value");
  open.add(o);
  if (Array.isArray(o)) {
    const arr = o;
    out.push("[");
    for (let i = 0; i < arr.length; i++) {
      if (!(i in arr)) throw new TypeError(`canonicalJson: sparse array hole at index ${i}`);
      if (i > 0) out.push(",");
      write(arr[i], out, open, depth + 1);
    }
    out.push("]");
  } else {
    if (!isPlainObject(o)) throw new TypeError(`canonicalJson: ${o.constructor?.name ?? "object"} is not a plain object`);
    const rec = o;
    const keys = Object.keys(rec).filter((k) => rec[k] !== void 0).sort();
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (i > 0) out.push(",");
      out.push(JSON.stringify(k), ":");
      write(rec[k], out, open, depth + 1);
    }
    out.push("}");
  }
  open.delete(o);
}
function canonicalJson(v) {
  const out = [];
  write(v, out, /* @__PURE__ */ new Set(), 1);
  return out.join("");
}
function canonicalBytes(v) {
  return Buffer.from(canonicalJson(v), "utf8");
}

// src/board/ops.ts
var OP_TYPES = /* @__PURE__ */ new Set([
  "join",
  "leave",
  "caps",
  "seat_start",
  "seat_end",
  "claim",
  "release",
  "request",
  "request_status",
  "answer",
  "note",
  "presume_absent",
  "hold",
  "event",
  "save"
]);
var PLAN2_FOLDED_TYPES = /* @__PURE__ */ new Set(["join", "leave", "caps", "seat_start", "seat_end", "event", "save"]);
var OPS_MAX_LINES = 1e3;
var OPS_MAX_BYTES = 65536;
var OP_MAX_LINE_BYTES = 16384;
var REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
var EVENT_KINDS2 = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach", "freeze", "unfreeze", "incident", "nonretryable", "health"]);
var CID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
function isObj(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
var isStr = (v) => typeof v === "string";
var isBool = (v) => typeof v === "boolean";
var isStrArray = (v) => Array.isArray(v) && v.every(isStr);
function fingerprint(v) {
  if (!isObj(v) || !isObj(v["filters"])) return null;
  const filters = v["filters"];
  if (!Object.values(filters).every(isStr)) return null;
  const { autocrlf, eol_attrs: eolAttrs, git } = v;
  if (!isStr(autocrlf) || !isStr(eolAttrs) || !isStr(git)) return null;
  return { filters: Object.fromEntries(Object.entries(filters)), autocrlf, eol_attrs: eolAttrs, git };
}
function typed(id, type, v) {
  switch (type) {
    case "join": {
      const { display, plugin_version: pv, plugin_sha: ps, proto, regionSpec, coauthor_optin: co } = v;
      const cf = fingerprint(v["config_fingerprint"]);
      if (!isStr(display) || !isStr(pv) || !isStr(ps) || !isStr(regionSpec) || cf === null) return null;
      if (typeof proto !== "number" || !Number.isSafeInteger(proto) || proto < 0) return null;
      if (co !== false && !isStr(co)) return null;
      return { id, type, display, plugin_version: pv, plugin_sha: ps, proto, regionSpec, config_fingerprint: cf, coauthor_optin: co };
    }
    case "leave":
      return { id, type };
    case "caps": {
      const { custom_refs: cr, lease, delete: del, push_options: po, two_parent_ok: tp } = v;
      if (!isBool(cr) || !isBool(lease) || !isBool(del) || !isBool(po) || !isBool(tp)) return null;
      return { id, type, custom_refs: cr, lease, delete: del, push_options: po, two_parent_ok: tp };
    }
    case "seat_start":
    case "seat_end": {
      const { seat_id: seat, permission_mode: mode } = v;
      if (!isStr(seat) || !validId("hex128", seat) || !isStr(mode)) return null;
      return { id, type, seat_id: seat, permission_mode: mode };
    }
    case "event": {
      const { cid, kind, refs, reason_code: rc } = v;
      if (!isStr(cid) || !CID_RE.test(cid) || !isStr(kind) || !EVENT_KINDS2.has(kind) || !isStrArray(refs)) return null;
      if (!isStr(rc) || !REASON_CODE_RE.test(rc)) return null;
      return { id, type, cid, kind, refs: [...refs], reason_code: rc };
    }
    case "save": {
      const { save_commit: sc, saved_live: sl, chain_base: cb, released_claim_ids: rel } = v;
      if (!isOid(sc) || !isOid(sl) || !isOid(cb) || !isStrArray(rel)) return null;
      return { id, type, save_commit: sc, saved_live: sl, chain_base: cb, released_claim_ids: [...rel] };
    }
    default:
      return opaque(type, v);
  }
}
function opaque(type, v) {
  const required = type === "claim" || type === "request" ? "path" : type === "hold" ? "paths" : null;
  if (required !== null && !(required in v)) return null;
  if ("path" in v && !(isStr(v["path"]) && validPathSyntax(v["path"]))) return null;
  if ("paths" in v && !(isStrArray(v["paths"]) && v["paths"].every(validPathSyntax))) return null;
  if ("cs_id" in v && !(isStr(v["cs_id"]) && validId("cs", v["cs_id"]))) return null;
  if ("cs_ids" in v && !(isStrArray(v["cs_ids"]) && v["cs_ids"].every((s) => validId("cs", s)))) return null;
  for (const k of ["hold_id", "req_id"]) {
    if (k in v && !(isStr(v[k]) && validId("ulid", v[k]))) return null;
  }
  if ("reason_code" in v && !(isStr(v["reason_code"]) && REASON_CODE_RE.test(v["reason_code"]))) return null;
  return v;
}
function nestedDeeperThan(v, max) {
  const values = [v];
  const depths = [1];
  while (values.length > 0) {
    const x = values.pop();
    const d = depths.pop();
    if (typeof x !== "object" || x === null) continue;
    if (d > max) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) {
      if (typeof child === "object" && child !== null) {
        values.push(child);
        depths.push(d + 1);
      }
    }
  }
  return false;
}
function parseOpLine(line) {
  try {
    if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > OP_MAX_LINE_BYTES) return null;
    const v = JSON.parse(line);
    if (nestedDeeperThan(v, MAX_JSON_DEPTH) || !isObj(v)) return null;
    const { id, type } = v;
    if (!isStr(id) || parseOpId(id) === null || !isStr(type) || !OP_TYPES.has(type)) return null;
    const op = typed(id, type, v);
    if (op === null) return null;
    canonicalJson(op);
    return op;
  } catch {
    return null;
  }
}

// src/board/protocol.ts
var PROTO = 1;
var FALLBACK = { budget: 6, G_s: 10, S_s: 3 };
var positive = (v, fallback) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
function readProtocol(buf) {
  let v = null;
  if (buf !== null) {
    try {
      v = JSON.parse(buf.toString("utf8"));
    } catch {
      v = null;
    }
  }
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  const proto = o["proto"];
  return {
    proto: typeof proto === "number" && Number.isSafeInteger(proto) && proto >= 0 ? proto : 0,
    regionSpec: typeof o["regionSpec"] === "string" ? o["regionSpec"] : "",
    budget: positive(o["budget"], FALLBACK.budget),
    G_s: positive(o["G_s"], FALLBACK.G_s),
    S_s: positive(o["S_s"], FALLBACK.S_s)
  };
}

// src/board/boardCommit.ts
var BOARD_TREE_MAX_BYTES = 5e6;
var BOARD_COMMIT_OBJECT_MAX_BYTES = 1048576;
var BOARD_ROOT_TREE_MAX_BYTES = 4096;
var BATCH_READ_MAX_BYTES = 33554432;
var SKIP_CHECKS = "skip-checks";
var PROTO_KEY = "Cowork-Proto";
var CS_KEY = "Cowork-CS";
var CS_PATHS_KEY = "Cowork-CS-Paths";
var BASE_KEY = "Cowork-Base";
var CS_PATHS_MAX = 256;
var CS_PATHS_MAX_BYTES = CS_PATHS_MAX * 4096 + CS_PATHS_MAX - 1;
var CS_STATES = /* @__PURE__ */ new Set(["closed", "checkpoint"]);
var CS_ORIGINS = /* @__PURE__ */ new Set(["prompt", "wake", "human"]);
var CS_CHECKS = /* @__PURE__ */ new Set(["pass", "fail", "skipped"]);
var COUNT_RE = /^(?:0|[1-9][0-9]*)$/;
function parseWriter(s) {
  return parseOpId(s);
}
function parseCount(s) {
  if (!COUNT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
function parseCs(value) {
  const t = value.split(" ");
  if (t.length !== 6) return null;
  const field = (i, key) => t[i].startsWith(`${key}=`) ? t[i].slice(key.length + 1) : null;
  const csId = t[0];
  const state = field(1, "state");
  const seq = field(2, "seq");
  const origin = field(3, "origin");
  const checks = field(4, "checks");
  const paths = field(5, "paths");
  if (!validId("cs", csId) || state === null || !CS_STATES.has(state) || origin === null || !CS_ORIGINS.has(origin) || checks === null || !CS_CHECKS.has(checks)) return null;
  const seqN = seq === null ? null : parseCount(seq);
  const pathsN = paths === null ? null : parseCount(paths);
  if (seqN === null || pathsN === null) return null;
  return { csId, state, seq: seqN, origin, checks, paths: pathsN };
}
function decodeCsPaths(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let raw;
  try {
    raw = inflateSync(Buffer.from(s, "base64url"), { maxOutputLength: CS_PATHS_MAX_BYTES });
  } catch {
    return null;
  }
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) return null;
  if (text.length === 0) return [];
  const paths = text.split("\0");
  if (paths.length > CS_PATHS_MAX || !paths.every((p) => validPathSyntax(p)) || new Set(paths).size !== paths.length) return null;
  return paths;
}
function parseCsTrailers(trailers) {
  const cs = [];
  const counts = /* @__PURE__ */ new Map();
  for (const t of trailers) {
    if (t.key !== CS_KEY) continue;
    const c = parseCs(t.value);
    if (c === null || counts.has(c.csId)) continue;
    cs.push(c);
    counts.set(c.csId, c.paths);
  }
  const paths = /* @__PURE__ */ new Map();
  for (const t of trailers) {
    if (t.key !== CS_PATHS_KEY) continue;
    const sp = t.value.indexOf(" ");
    if (sp <= 0) continue;
    const csId = t.value.slice(0, sp);
    const n = counts.get(csId);
    if (n === void 0 || paths.has(csId)) continue;
    const list = decodeCsPaths(t.value.slice(sp + 1));
    if (list !== null && list.length === n) paths.set(csId, list);
  }
  return { cs, paths };
}
function isAbsentRecord(parts) {
  return parts.length === 2 && parts[0].length > 0 && /^[a-z]+$/.test(parts[1]);
}
function batchObjects(out, expected) {
  const items = [];
  let pos2 = 0;
  while (items.length < expected) {
    const nl = out.indexOf(10, pos2);
    if (nl < 0) throw new Error("cat-file --batch: truncated output");
    const parts = out.toString("utf8", pos2, nl).split(" ");
    pos2 = nl + 1;
    if (isAbsentRecord(parts)) {
      items.push(null);
      continue;
    }
    const size2 = Number(parts[2]);
    if (parts.length !== 3 || !Number.isSafeInteger(size2) || size2 < 0 || pos2 + size2 > out.length) {
      throw new Error(`cat-file --batch: malformed header ${JSON.stringify(parts.join(" ").slice(0, 120))}`);
    }
    items.push({ type: parts[1], body: out.subarray(pos2, pos2 + size2) });
    pos2 += size2 + 1;
  }
  return items;
}
function subtreeNames(raw, hashBytes) {
  const names = [];
  let pos2 = 0;
  while (pos2 < raw.length) {
    const sp = raw.indexOf(32, pos2);
    const nul = sp < 0 ? -1 : raw.indexOf(0, sp + 1);
    if (nul < 0 || nul + 1 + hashBytes > raw.length) throw new Error("readBoardCommit: malformed tree object");
    if (raw.toString("latin1", pos2, sp) === "40000") names.push(raw.toString("utf8", sp + 1, nul));
    pos2 = nul + 1 + hashBytes;
  }
  return names;
}
function batchCheck(out, expected) {
  const lines = out.toString("utf8").split("\n");
  const items = [];
  for (let i = 0; i < expected; i++) {
    const line = lines[i];
    if (line === void 0 || i + 1 >= lines.length) throw new Error("cat-file --batch-check: truncated output");
    const parts = line.split(" ");
    if (isAbsentRecord(parts)) {
      items.push(null);
      continue;
    }
    const size2 = Number(parts[2]);
    if (parts.length !== 3 || !isOid(parts[0]) || !Number.isSafeInteger(size2) || size2 < 0) {
      throw new Error(`cat-file --batch-check: malformed record ${JSON.stringify(line.slice(0, 120))}`);
    }
    items.push({ oid: parts[0], type: parts[1], size: size2 });
  }
  return items;
}
function capViolation(e) {
  const root = e.root?.size ?? 0;
  if (root > BOARD_ROOT_TREE_MAX_BYTES) return { reason: "board_too_large", detail: `a root tree object of ${root} bytes > ${BOARD_ROOT_TREE_MAX_BYTES}` };
  if (e.ops !== null && e.ops.size > OPS_MAX_BYTES) return { reason: "ops_too_large", detail: `an ops.jsonl of ${e.ops.size} bytes > ${OPS_MAX_BYTES}` };
  const files = (e.ops?.size ?? 0) + (e.protocol?.size ?? 0) + (e.checkpoint?.size ?? 0);
  const held = e.held?.size ?? 0;
  if (files > BOARD_TREE_MAX_BYTES || held > BOARD_TREE_MAX_BYTES) {
    return { reason: "board_too_large", detail: `more than the ${BOARD_TREE_MAX_BYTES}-byte board tree cap (files ${files}, held/ ${held})` };
  }
  if (e.checkpoint === null) return { reason: "entry_missing", detail: "no checkpoint/state.json blob (PRO-02)" };
  return null;
}
var UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeLine(bytes2) {
  try {
    return UTF8_STRICT.decode(bytes2);
  } catch {
    return "";
  }
}
function opsLinesOf(buf) {
  const lines = [];
  if (buf === null) return lines;
  let pos2 = 0;
  while (lines.length < OPS_MAX_LINES && pos2 < buf.length) {
    const lf = buf.indexOf(10, pos2);
    const end = lf < 0 ? buf.length : lf;
    lines.push(decodeLine(buf.subarray(pos2, end)));
    pos2 = end + 1;
  }
  return lines;
}
function hasMarkers(c) {
  return c.subject.startsWith(SKIP_SUBJECT_PREFIX) && c.trailers.some((t) => t.key === SKIP_CHECKS) && c.trailers.some((t) => t.key === PROTO_KEY);
}
function liveShape(c, expectedPrev) {
  if (!hasMarkers(c)) return null;
  const bases = c.trailers.filter((t) => t.key === BASE_KEY).map((t) => t.value);
  if (expectedPrev === null) return c.parents.length === 0 && bases.length === 1 && isOid(bases[0]) ? "genesis" : null;
  if (c.parents[0] !== expectedPrev) return null;
  if (c.parents.length === 1) return bases.length === 0 ? "ordinary" : null;
  if (c.parents.length === 2) return bases.length === 1 && bases[0] === c.parents[1] ? "base_move" : null;
  return null;
}

// src/board/fold.ts
var CHECKPOINT_EVERY = 256;
var COMPACT_AGE = 512;
var K_EVICT = 200;
var CONFLICT_KINDS = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach"]);
var EVENT_KINDS3 = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach", "freeze", "unfreeze", "incident", "nonretryable", "health"]);
var OP_TYPES2 = /* @__PURE__ */ new Set([
  "join",
  "leave",
  "caps",
  "seat_start",
  "seat_end",
  "claim",
  "release",
  "request",
  "request_status",
  "answer",
  "note",
  "presume_absent",
  "hold",
  "event",
  "save"
]);
var CID_RE2 = /^[0-9A-HJKMNP-TV-Z]{8}$/;
var has = (o, k) => Object.hasOwn(o, k);
var isInt = (x, min) => typeof x === "number" && Number.isSafeInteger(x) && x >= min;
function peerOf(s, peer) {
  return has(s.peers, peer) ? s.peers[peer] : void 0;
}
function initialFoldState(protocol) {
  return {
    v: 1,
    height: -1,
    proto: isInt(protocol.proto, 0) ? protocol.proto : 0,
    teamRegionSpec: protocol.regionSpec,
    caps: null,
    peers: {},
    seats: {},
    claims: {},
    requests: {},
    holds: {},
    notes: {},
    events: {},
    last_save: null,
    record_count: 0
  };
}
function validWriter(w) {
  if (w === null || typeof w !== "object") return null;
  return validId("hex128", w.peer) && validId("hex128", w.epoch) && isInt(w.seq, 1) ? w : null;
}
function genericOk(s, w, id, prevSeq, type) {
  if (id.peer !== w.peer || id.epoch !== w.epoch) return false;
  if (id.seq >= w.seq || id.seq <= prevSeq) return false;
  const rec = peerOf(s, w.peer);
  if (rec !== void 0) {
    if (rec.retired_epochs.includes(w.epoch)) return false;
    if (rec.epoch === w.epoch && id.seq <= rec.last_seq) return false;
  }
  return type === "join" || rec !== void 0 && rec.epoch === w.epoch && rec.status === "active";
}
function endSeats(s, peer, epoch, h) {
  const prefix = `${peer}/${epoch}/`;
  for (const [key, seat] of Object.entries(s.seats)) {
    if (key.startsWith(prefix) && seat.status === "live") s.seats[key] = { status: "ended", permission_mode: seat.permission_mode, ended_height: h };
  }
}
function applyJoin(s, w, op, seq, h) {
  const cf = op.config_fingerprint;
  const fields = {
    display: op.display,
    plugin_version: op.plugin_version,
    plugin_sha: op.plugin_sha,
    regionSpec: op.regionSpec,
    config_fingerprint: { filters: Object.fromEntries(Object.entries(cf.filters)), autocrlf: cf.autocrlf, eol_attrs: cf.eol_attrs, git: cf.git },
    coauthor_optin: op.coauthor_optin
  };
  const rec = peerOf(s, w.peer);
  if (rec === void 0) {
    s.peers[w.peer] = { epoch: w.epoch, status: "active", retired_epochs: [], ...fields, last_seq: seq, last_height: -1 };
    return;
  }
  if (rec.epoch !== w.epoch) {
    rec.retired_epochs.push(rec.epoch);
    endSeats(s, w.peer, rec.epoch, h);
    rec.epoch = w.epoch;
    rec.last_seq = seq;
  }
  rec.status = "active";
  Object.assign(rec, fields);
}
function applyOp(s, w, op, seq, h) {
  switch (op.type) {
    case "join":
      applyJoin(s, w, op, seq, h);
      return true;
    case "leave": {
      peerOf(s, w.peer).status = "left";
      endSeats(s, w.peer, w.epoch, h);
      return true;
    }
    case "seat_start": {
      const key = `${w.peer}/${w.epoch}/${op.seat_id}`;
      if (has(s.seats, key) && s.seats[key].status === "live") return false;
      s.seats[key] = { status: "live", permission_mode: op.permission_mode };
      return true;
    }
    case "seat_end": {
      const key = `${w.peer}/${w.epoch}/${op.seat_id}`;
      const cur = has(s.seats, key) ? s.seats[key] : void 0;
      if (cur === void 0 || cur.status !== "live") return false;
      s.seats[key] = { status: "ended", permission_mode: cur.permission_mode, ended_height: h };
      return true;
    }
    case "event": {
      if (CONFLICT_KINDS.has(op.kind) && has(s.events, op.cid)) return false;
      s.events[op.cid] = { kind: op.kind, refs: [...op.refs], reason_code: op.reason_code, op_id: op.id, height: h };
      return true;
    }
    case "caps":
      s.caps = { custom_refs: op.custom_refs, lease: op.lease, delete: op.delete, push_options: op.push_options, two_parent_ok: op.two_parent_ok };
      return true;
    case "save":
      s.last_save = { save_commit: op.save_commit, saved_live: op.saved_live, chain_base: op.chain_base, height: h };
      return true;
    default:
      return true;
  }
}
function malformedRejection(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const id = v["id"];
  const type = v["type"];
  if (typeof id !== "string" || parseOpId(id) === null) return null;
  return { opId: id, type: typeof type === "string" && OP_TYPES2.has(type) ? type : "unknown", reason: "type" };
}
function reevaluateTeamRegionSpec(s) {
  const r = rankedSet(s);
  if (r.length === 0) return;
  const x = s.peers[r[0]].regionSpec;
  if (x !== s.teamRegionSpec && r.every((p) => s.peers[p].regionSpec === x)) s.teamRegionSpec = x;
}
function compact(s, h) {
  const limit = h - COMPACT_AGE;
  for (const [cid, e] of Object.entries(s.events)) {
    if (e.height <= limit) delete s.events[cid];
  }
  for (const [key, seat] of Object.entries(s.seats)) {
    if (seat.status === "ended" && seat.ended_height !== void 0 && seat.ended_height <= limit) delete s.seats[key];
  }
}
function countRecords(s) {
  let ended = 0;
  for (const seat of Object.values(s.seats)) if (seat.status === "ended") ended++;
  return Object.keys(s.claims).length + Object.keys(s.requests).length + Object.keys(s.holds).length + Object.keys(s.events).length + Object.keys(s.notes).length + ended;
}
function foldCommit(prev, c, self) {
  const s = structuredClone(prev);
  const h = prev.height + 1;
  s.height = h;
  const ownRejections = [];
  const landedOwnOpIds = [];
  const opVerdicts = c.opsLines.map((_, line) => ({ line, opId: null, type: "unknown", verdict: "rejected", reason: "generic" }));
  const proto = isInt(c.protocol.proto, 0) ? c.protocol.proto : 0;
  s.proto = proto;
  const w = validWriter(c.writer);
  if (w !== null) {
    const own2 = w.peer === self;
    let prevSeq = 0;
    let bytes2 = 0;
    const n = Math.min(c.opsLines.length, OPS_MAX_LINES);
    for (let i = 0; i < n; i++) {
      const line = c.opsLines[i];
      bytes2 += Buffer.byteLength(line, "utf8") + 1;
      if (bytes2 > OPS_MAX_BYTES) break;
      const op = parseOpLine(line);
      if (op === null) {
        opVerdicts[i] = { line: i, opId: null, type: "unknown", verdict: "rejected", reason: "malformed" };
        const r = own2 ? malformedRejection(line) : null;
        if (r !== null) ownRejections.push(r);
        continue;
      }
      const id = parseOpId(op.id);
      if (id === null) {
        opVerdicts[i] = { line: i, opId: null, type: "unknown", verdict: "rejected", reason: "malformed" };
        continue;
      }
      const ok = genericOk(s, w, id, prevSeq, op.type);
      if (id.peer === w.peer && id.epoch === w.epoch && id.seq > prevSeq) prevSeq = id.seq;
      if (!ok) {
        opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: "rejected", reason: "generic" };
        if (own2) ownRejections.push({ opId: op.id, type: op.type, reason: "generic" });
        continue;
      }
      if (!applyOp(s, w, op, id.seq, h)) {
        opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: "rejected", reason: "type" };
        if (own2) ownRejections.push({ opId: op.id, type: op.type, reason: "type" });
        continue;
      }
      opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: PLAN2_FOLDED_TYPES.has(op.type) ? "effective" : "unfolded" };
      if (own2) landedOwnOpIds.push(op.id);
    }
    const rec = peerOf(s, w.peer);
    if (rec !== void 0) {
      rec.last_height = h;
      if (rec.epoch === w.epoch) rec.last_seq = Math.max(rec.last_seq, w.seq);
    }
  }
  reevaluateTeamRegionSpec(s);
  if (h % CHECKPOINT_EVERY === 0) compact(s, h);
  s.record_count = countRecords(s);
  return { state: s, ownRejections, landedOwnOpIds, protoMismatch: proto !== PROTO, opVerdicts };
}
function serializeFold(s) {
  return canonicalBytes(s);
}
var STATE_KEYS = ["caps", "claims", "events", "height", "holds", "last_save", "notes", "peers", "proto", "record_count", "requests", "seats", "teamRegionSpec", "v"];
var PEER_KEYS = ["coauthor_optin", "config_fingerprint", "display", "epoch", "last_height", "last_seq", "plugin_sha", "plugin_version", "regionSpec", "retired_epochs", "status"];
var CAPS_KEYS = ["custom_refs", "delete", "lease", "push_options", "two_parent_ok"];
var EVENT_KEYS = ["height", "kind", "op_id", "reason_code", "refs"];
var SAVE_KEYS = ["chain_base", "height", "save_commit", "saved_live"];
var PEER_STATUS = /* @__PURE__ */ new Set(["active", "left", "absent"]);
function isObj2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function keysAre(o, keys) {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
}
var isStrArray2 = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function toPeer(v) {
  if (!isObj2(v) || !keysAre(v, PEER_KEYS)) return null;
  const { epoch, status, retired_epochs: retired, display, plugin_version: pv, plugin_sha: ps, regionSpec, config_fingerprint: cf, coauthor_optin: co, last_seq: ls, last_height: lh } = v;
  if (typeof epoch !== "string" || !validId("hex128", epoch) || typeof status !== "string" || !PEER_STATUS.has(status)) return null;
  if (!isStrArray2(retired) || !retired.every((e) => validId("hex128", e))) return null;
  if (typeof display !== "string" || typeof pv !== "string" || typeof ps !== "string" || typeof regionSpec !== "string") return null;
  if (co !== false && typeof co !== "string") return null;
  if (!isInt(ls, 0) || !isInt(lh, -1)) return null;
  return {
    epoch,
    status,
    retired_epochs: retired,
    display,
    plugin_version: pv,
    plugin_sha: ps,
    regionSpec,
    config_fingerprint: cf,
    coauthor_optin: co,
    last_seq: ls,
    last_height: lh
  };
}
function toSeat(v) {
  if (!isObj2(v) || typeof v["permission_mode"] !== "string") return null;
  if (v["status"] === "live" && keysAre(v, ["permission_mode", "status"])) return { status: "live", permission_mode: v["permission_mode"] };
  if (v["status"] === "ended" && keysAre(v, ["ended_height", "permission_mode", "status"]) && isInt(v["ended_height"], 0)) {
    return { status: "ended", permission_mode: v["permission_mode"], ended_height: v["ended_height"] };
  }
  return null;
}
function toEvent(v) {
  if (!isObj2(v) || !keysAre(v, EVENT_KEYS)) return null;
  const { kind, refs, reason_code: rc, op_id: opId, height } = v;
  if (typeof kind !== "string" || !EVENT_KINDS3.has(kind) || !isStrArray2(refs)) return null;
  if (typeof rc !== "string" || !REASON_CODE_RE.test(rc) || typeof opId !== "string" || !validId("op", opId) || !isInt(height, 0)) return null;
  return { kind, refs, reason_code: rc, op_id: opId, height };
}
function toRecord(v, keyOk, conv) {
  if (!isObj2(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!keyOk(k)) return null;
    const t = conv(x);
    if (t === null) return null;
    out[k] = t;
  }
  return out;
}
var seatKeyOk = (k) => {
  const parts = k.split("/");
  return parts.length === 3 && parts.every((p) => validId("hex128", p));
};
function toFoldState(v) {
  if (!isObj2(v) || !keysAre(v, STATE_KEYS)) return null;
  if (v["v"] !== 1 || !isInt(v["height"], -1) || !isInt(v["proto"], 0) || typeof v["teamRegionSpec"] !== "string" || !isInt(v["record_count"], 0)) return null;
  const capsV = v["caps"];
  let caps = null;
  if (capsV !== null) {
    if (!isObj2(capsV) || !keysAre(capsV, CAPS_KEYS) || !CAPS_KEYS.every((k) => typeof capsV[k] === "boolean")) return null;
    caps = { custom_refs: capsV["custom_refs"], lease: capsV["lease"], delete: capsV["delete"], push_options: capsV["push_options"], two_parent_ok: capsV["two_parent_ok"] };
  }
  const saveV = v["last_save"];
  let lastSave = null;
  if (saveV !== null) {
    if (!isObj2(saveV) || !keysAre(saveV, SAVE_KEYS) || !isOid(saveV["save_commit"]) || !isOid(saveV["saved_live"]) || !isOid(saveV["chain_base"]) || !isInt(saveV["height"], 0)) return null;
    lastSave = { save_commit: saveV["save_commit"], saved_live: saveV["saved_live"], chain_base: saveV["chain_base"], height: saveV["height"] };
  }
  const peers = toRecord(v["peers"], (k) => validId("hex128", k), toPeer);
  const seats = toRecord(v["seats"], seatKeyOk, toSeat);
  const events = toRecord(v["events"], (k) => CID_RE2.test(k), toEvent);
  const opaque2 = (x) => isObj2(x) ? x : null;
  const claims = opaque2(v["claims"]);
  const requests = opaque2(v["requests"]);
  const holds = opaque2(v["holds"]);
  const notes = opaque2(v["notes"]);
  if (peers === null || seats === null || events === null || claims === null || requests === null || holds === null || notes === null) return null;
  const s = {
    v: 1,
    height: v["height"],
    proto: v["proto"],
    teamRegionSpec: v["teamRegionSpec"],
    caps,
    peers,
    seats,
    claims,
    requests,
    holds,
    notes,
    events,
    last_save: lastSave,
    record_count: v["record_count"]
  };
  return countRecords(s) === s.record_count && !datedAbove(s) ? s : null;
}
function datedAbove(s) {
  const h = s.height;
  if (s.last_save !== null && s.last_save.height > h) return true;
  if (Object.values(s.events).some((e) => e.height > h)) return true;
  if (Object.values(s.seats).some((x) => x.ended_height !== void 0 && x.ended_height > h)) return true;
  return Object.values(s.peers).some((p) => p.last_height > h);
}
function parseFold(buf) {
  try {
    const s = toFoldState(JSON.parse(buf.toString("utf8")));
    return s !== null && serializeFold(s).equals(buf) ? s : null;
  } catch {
    return null;
  }
}
function liveSet(s) {
  return Object.keys(s.peers).filter((p) => s.peers[p].status === "active").sort();
}
function rankedSet(s) {
  return liveSet(s).filter((p) => s.height - s.peers[p].last_height < K_EVICT);
}
var READ_CACHE_MAX_BYTES = 16 * 1048576;

// src/viz/model/frame.ts
var ZERO_PEER = "00000000000000000000000000000000";
function toDraft(o) {
  const d = {
    liveCode: parseOid(o.liveCode),
    writer: o.writer === null ? null : { peer: o.writer.peer, epoch: o.writer.epoch, seq: o.writer.seq },
    cs: o.cs.map((c) => ({ csId: c.csId, state: c.state, seq: c.seq, origin: c.origin, checks: c.checks, paths: c.paths })),
    protocol: { proto: o.protocol.proto, regionSpec: o.protocol.regionSpec, budget: o.protocol.budget, G_s: o.protocol.G_s, S_s: o.protocol.S_s },
    opsLines: [...o.opsLines],
    checkpoint: o.checkpoint,
    heldIds: [...o.heldIds]
  };
  return d;
}
function noopDraft(prev) {
  return toDraft({ liveCode: prev.liveCode, writer: null, cs: [], protocol: prev.protocol, opsLines: [], checkpoint: null, heldIds: [] });
}
function foldFrame(prev, x, self) {
  if (x.height !== prev.height + 1) throw new RangeError(`foldFrame: a frame at height ${x.height} does not follow a state at height ${prev.height}`);
  const r = foldCommit(prev, x.draft, self);
  const after = r.state;
  const cp = x.draft.checkpoint;
  const checkpoint = cp !== null && x.height % CHECKPOINT_EVERY === 0 ? serializeFold(after).equals(cp) ? "match" : "mismatch" : null;
  const ops = r.opVerdicts.map((v) => {
    const op = v.opId === null ? null : parseOpLine(x.draft.opsLines[v.line]);
    return { line: v.line, type: v.type, op: op === null ? null : op, verdict: v.verdict };
  });
  const code = x.height === 0 ? { changed: false, shape: x.code.shape, seats: [...x.code.seats], base: x.code.base } : { changed: x.code.changed, shape: x.code.changed ? x.code.shape : null, seats: [...x.code.seats], base: x.code.base };
  const w = x.draft.writer;
  return {
    height: x.height,
    oid: x.oid,
    writer: w === null ? null : { peer: w.peer, epoch: w.epoch, seq: w.seq },
    cs: x.draft.cs.map((c) => ({ ...c })),
    csPaths: x.csPaths,
    code,
    ops,
    before: prev,
    after,
    protoMismatch: r.protoMismatch,
    checkpoint,
    malformed: x.malformed
  };
}

// src/viz/model/timeline.ts
import { createHash as createHash4 } from "node:crypto";

// src/board/csActor.ts
function counter(s) {
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 && String(n) === s ? n : null;
}
function parseCsActor(csId) {
  if (typeof csId !== "string" || !validId("cs", csId)) return null;
  const parts = csId.split("/");
  if (parts.length === 3) {
    const n = counter(parts[2]);
    return n === null ? null : { kind: "human", peer: parts[0], n };
  }
  const turnSeq = counter(parts[1]);
  return turnSeq === null ? null : { kind: "seat", seat: parts[0], turnSeq };
}

// src/viz/model/cards.ts
var CARD_GROUP = Object.freeze(
  Object.assign(/* @__PURE__ */ Object.create(null), {
    UI_VIZ_CARD_REQUEST: "conversation",
    UI_VIZ_CARD_ANSWER: "conversation",
    UI_VIZ_CARD_NOTE: "conversation",
    UI_VIZ_CARD_JOIN: "conversation",
    UI_VIZ_CARD_REJOIN: "conversation",
    UI_VIZ_CARD_LEAVE: "conversation",
    UI_VIZ_CARD_SEAT_START: "conversation",
    UI_VIZ_CARD_SEAT_END: "conversation",
    UI_VIZ_CARD_ABSENT: "conversation",
    UI_VIZ_CARD_K4: "conflict",
    UI_VIZ_CARD_CONFLICT: "conflict",
    UI_VIZ_CARD_BREACH: "conflict",
    UI_VIZ_CARD_PUBLISH: "activity",
    UI_VIZ_CARD_ROOM_OPEN: "system",
    UI_VIZ_CARD_VERSION: "system",
    UI_VIZ_CARD_RULES: "system",
    UI_VIZ_CARD_HEALTH: "system",
    UI_VIZ_CARD_FREEZE: "system",
    UI_VIZ_CARD_THAW: "system",
    UI_VIZ_CARD_SLOWED: "system",
    UI_VIZ_CARD_NONRETRYABLE: "system",
    UI_VIZ_CARD_SAVE: "system",
    UI_VIZ_CARD_BASE_MOVE: "system",
    UI_VIZ_CARD_BOARD_FULL: "system"
  })
);
var copyActor3 = (a) => "peer" in a ? { peer: a.peer } : { seat: a.seat };
var conflictId = (e) => e.source === "event" ? e.cid === null ? null : `C${e.cid}` : e.holdId === null ? null : e.holdId.slice(0, 8);
var conflictFacts = (e) => ({ actor: copyActor3(e.on), desks: e.desk === null ? [] : [e.desk], displayId: conflictId(e) });
function cardOf(e, row) {
  switch (row) {
    case "genesis":
      return e.kind === "room_open" ? { code: "UI_VIZ_CARD_ROOM_OPEN", facts: {} } : null;
    case "join_new":
    case "join_back":
      return e.kind === "person_enter" ? { code: "UI_VIZ_CARD_JOIN", facts: { actor: { peer: e.peer } } } : null;
    case "join_epoch":
      return e.kind === "person_respawn" ? { code: "UI_VIZ_CARD_REJOIN", facts: { actor: { peer: e.peer } } } : null;
    case "join_version":
      return e.kind === "person_badge" && e.badge === "version" ? { code: "UI_VIZ_CARD_VERSION", facts: { actor: copyActor3(e.actor) } } : null;
    case "join_rules":
    case "rules_change":
      return e.kind === "person_badge" && e.badge === "rules" && e.on ? { code: "UI_VIZ_CARD_RULES", facts: { actor: copyActor3(e.actor) } } : null;
    case "leave":
      return e.kind === "person_exit" ? { code: "UI_VIZ_CARD_LEAVE", facts: { actor: { peer: e.peer } } } : null;
    case "seat_start":
      return e.kind === "pet_spawn" ? { code: "UI_VIZ_CARD_SEAT_START", facts: { actor: { seat: e.seat } } } : null;
    case "seat_end":
      return e.kind === "pet_poof" ? { code: "UI_VIZ_CARD_SEAT_END", facts: { actor: { seat: e.seat } } } : null;
    case "publish_cs":
    case "publish_big":
    case "publish_nocs":
      return e.kind === "publish" ? { code: "UI_VIZ_CARD_PUBLISH", facts: { actor: copyActor3(e.actor), paths: [...e.paths], n: e.n, desks: [e.target, ...e.others] } } : null;
    case "base_move":
      return e.kind === "room_sign" ? { code: "UI_VIZ_CARD_BASE_MOVE", facts: {} } : null;
    case "freeze":
      return e.kind === "person_freeze" ? { code: "UI_VIZ_CARD_FREEZE", facts: { actor: { peer: e.peer }, detail: e.reasonCode } } : null;
    case "unfreeze":
      return e.kind === "person_thaw" ? { code: "UI_VIZ_CARD_THAW", facts: { actor: { peer: e.peer } } } : null;
    case "slowed":
      return e.kind === "person_slowed" ? { code: "UI_VIZ_CARD_SLOWED", facts: { actor: { peer: e.peer } } } : null;
    case "board_full":
      return e.kind === "room_badge" && e.level === "full" ? { code: "UI_VIZ_CARD_BOARD_FULL", facts: {} } : null;
    case "health_other":
      return e.kind === "person_badge" && e.badge === "health" ? { code: "UI_VIZ_CARD_HEALTH", facts: { actor: copyActor3(e.actor), detail: e.code } } : null;
    case "nonretryable":
      return e.kind === "person_bang" ? { code: "UI_VIZ_CARD_NONRETRYABLE", facts: { actor: { peer: e.peer } } } : null;
    case "hold_k4":
      return e.kind === "conflict" ? { code: "UI_VIZ_CARD_K4", facts: conflictFacts(e) } : null;
    case "hold_claim":
    case "hold_t0":
    case "event_k":
      return e.kind === "conflict" ? { code: "UI_VIZ_CARD_CONFLICT", facts: conflictFacts(e) } : null;
    case "hold_breach":
    case "event_breach":
      return e.kind === "conflict" ? { code: "UI_VIZ_CARD_BREACH", facts: conflictFacts(e) } : null;
    case "request":
      return e.kind === "request_open" ? { code: "UI_VIZ_CARD_REQUEST", facts: { actor: copyActor3(e.from), target: copyActor3(e.holder), desks: [e.desk], displayId: e.request, text: e.note } } : null;
    case "answer":
      return e.kind === "answer" ? { code: "UI_VIZ_CARD_ANSWER", facts: { actor: copyActor3(e.holder), parent: e.request, text: e.note, detail: e.verb } } : null;
    case "note":
      return e.kind === "note" ? { code: "UI_VIZ_CARD_NOTE", facts: { actor: copyActor3(e.actor), parent: e.target !== null && "request" in e.target ? e.target.request : null, text: e.text } } : null;
    case "presume_absent":
      return e.kind === "person_absent" ? { code: "UI_VIZ_CARD_ABSENT", facts: { actor: { peer: e.peer } } } : null;
    case "save":
      return e.kind === "save" ? { code: "UI_VIZ_CARD_SAVE", facts: { actor: { peer: e.peer }, desks: [...e.desks] } } : null;
    // Uncarded rows (12 §3.4 "—"): credit badges, footprint spawns, every parcel transition, claims, reservations, grants,
    // request statuses (a chip on the request card), ghosts and relaxed poses.
    case "join_credit":
    case "seat_footprint":
    case "hold_other":
    case "claim_new":
    case "claim_reanchor":
    case "claim_stale":
    case "release":
    case "reserve":
    case "grant":
    case "request_status":
    case "ghost":
    case "relaxed":
      return null;
  }
}
function cardFor(e, row) {
  const c = cardOf(e, row);
  if (c === null) return null;
  const group = CARD_GROUP[c.code];
  if (group === void 0) return null;
  const f = c.facts;
  return {
    id: `${e.height}.${e.sub}.${e.k}`,
    at: { height: e.height, sub: e.sub, k: e.k },
    group,
    code: c.code,
    actor: f.actor ?? null,
    target: f.target ?? null,
    paths: f.paths ?? [],
    n: f.n ?? 0,
    desks: f.desks ?? [],
    displayId: f.displayId ?? null,
    parent: f.parent ?? null,
    label: f.label ?? null,
    text: f.text ?? null,
    detail: f.detail ?? null
  };
}

// src/viz/model/start.ts
var HOST_THROTTLED = "HOST_THROTTLED";
var BOARD_NEAR_FULL = 4e3;
var BOARD_FULL = 5e3;
var SLOWED_HEIGHTS = 180;
function ownerOfSeatKey(seat) {
  const i = seat.indexOf("/");
  return i < 0 ? seat : seat.slice(0, i);
}
function writerOf(e) {
  const id = parseOpId(e.op_id);
  return id === null ? null : { peer: id.peer, height: e.height, seq: id.seq };
}
function startScene(s, hs, layout) {
  const scene = emptyScene({ height: hs, sub: 0, k: 0 });
  const live = new Set(liveSet(s));
  const ranked = new Set(rankedSet(s));
  const newestFreeze = /* @__PURE__ */ new Map();
  const slowedUntil = /* @__PURE__ */ new Map();
  for (const e of Object.values(s.events)) {
    const w = writerOf(e);
    if (w === null) continue;
    if (e.kind === "freeze" || e.kind === "unfreeze") {
      const cur = newestFreeze.get(w.peer);
      if (cur === void 0 || w.height > cur.height || w.height === cur.height && w.seq > cur.seq) newestFreeze.set(w.peer, { height: w.height, seq: w.seq, e });
    }
    if (e.kind === "health" && e.reason_code === HOST_THROTTLED && e.height + SLOWED_HEIGHTS > hs) {
      slowedUntil.set(w.peer, Math.max(slowedUntil.get(w.peer) ?? 0, e.height + SLOWED_HEIGHTS));
    }
  }
  for (const peer of Object.keys(s.peers).sort()) {
    const rec = s.peers[peer];
    if (rec.status !== "active" && rec.status !== "absent") continue;
    const fz = newestFreeze.get(peer);
    const c = {
      place: { at: "home", spot: homeSpot(layout, peer) },
      pose: "idle",
      lastPublish: null,
      lastDesk: null,
      lastClaimOp: null,
      ghost: live.has(peer) && !ranked.has(peer),
      absent: rec.status === "absent",
      frozen: fz !== void 0 && fz.e.kind === "freeze" ? fz.e.reason_code : null,
      slowedUntil: slowedUntil.get(peer) ?? null,
      rules: rec.regionSpec !== s.teamRegionSpec,
      credit: rec.coauthor_optin !== false
    };
    scene.characters.set(peer, c);
  }
  const variants = /* @__PURE__ */ new Map();
  for (const key of Object.keys(s.seats).sort()) {
    if (s.seats[key].status !== "live") continue;
    const owner = ownerOfSeatKey(key);
    if (!scene.characters.has(owner)) continue;
    const variant = variants.get(owner) ?? 0;
    variants.set(owner, variant + 1);
    scene.pets.set(key, { place: { at: "behind", peer: owner }, pose: "idle", lastPublish: null, lastDesk: null, lastClaimOp: null, owner, variant, live: true, ssCode: null });
  }
  scene.badge = s.record_count >= BOARD_FULL ? "full" : s.record_count >= BOARD_NEAR_FULL ? "near_full" : "none";
  settlePlaces(scene, layout, null, null);
  return scene;
}

// src/viz/model/timeline.ts
var HOST_THROTTLED2 = "HOST_THROTTLED";
var BOARD_FULL_CODE = "BOARD_FULL";
function eventSeed(base, k) {
  return createHash4("sha256").update(`${base}:${k}`, "utf8").digest().readUInt32BE(0);
}
function actorOfCs(csId, writer) {
  const a = parseCsActor(csId);
  if (a === null) return null;
  return a.kind === "human" ? { peer: writer.peer } : { seat: `${writer.peer}/${writer.epoch}/${a.seat}` };
}
function actorState2(s, a) {
  if ("peer" in a) return s.characters.get(a.peer);
  const p = s.pets.get(a.seat);
  return p !== void 0 && p.live ? p : void 0;
}
function petsOf(s, peer, keep) {
  const out = [];
  for (const [seat, p] of s.pets) if (p.live && p.owner === peer && keep(seat)) out.push(seat);
  return out.sort();
}
var recOf = (s, peer) => Object.hasOwn(s.peers, peer) ? s.peers[peer] : void 0;
var rulesAfter = (c, peer) => {
  const r = recOf(c.frame.after, peer);
  return r !== void 0 && r.regionSpec !== c.frame.after.teamRegionSpec;
};
var joinRow = (c) => {
  const op = c.op;
  const w = c.writer;
  const peer = w.peer;
  const prev = c.rec(peer);
  if (prev === void 0 || prev.epoch !== w.epoch || prev.status !== "active") {
    c.home(peer);
    if (prev !== void 0 && prev.epoch !== w.epoch) {
      const retired = petsOf(c.scene(), peer, (seat) => !seat.startsWith(`${peer}/${w.epoch}/`));
      c.emit("join_epoch", { kind: "person_respawn", peer });
      for (const seat of retired) c.emit("join_epoch", { kind: "pet_poof", seat, owner: ownerOfSeatKey(seat) });
    } else {
      c.emit(prev === void 0 ? "join_new" : "join_back", { kind: "person_enter", peer });
    }
  }
  if (prev !== void 0 && prev.epoch === w.epoch && prev.plugin_version !== op.plugin_version) {
    c.emit("join_version", { kind: "person_badge", actor: { peer }, badge: "version", on: true, code: null });
  }
  const ch = c.scene().characters.get(peer);
  if (ch !== void 0) {
    const rules = rulesAfter(c, peer);
    if (ch.rules !== rules) c.emit("join_rules", { kind: "person_badge", actor: { peer }, badge: "rules", on: rules, code: null });
    const credit = op.coauthor_optin !== false;
    if (ch.credit !== credit) c.emit("join_credit", { kind: "person_badge", actor: { peer }, badge: "credit", on: credit, code: null });
  }
  c.setRec(peer, { epoch: w.epoch, status: "active", plugin_version: op.plugin_version });
};
var leaveRow = (c) => {
  const peer = c.writer.peer;
  const seats = petsOf(c.scene(), peer, () => true);
  c.emit("leave", { kind: "person_exit", peer });
  for (const seat of seats) c.emit("leave", { kind: "pet_poof", seat, owner: ownerOfSeatKey(seat) });
  const prev = c.rec(peer);
  if (prev !== void 0) c.setRec(peer, { ...prev, status: "left" });
};
var seatKey = (w, seatId) => `${w.peer}/${w.epoch}/${seatId}`;
var seatStartRow = (c) => {
  const seat = seatKey(c.writer, c.op.seat_id);
  c.emit("seat_start", { kind: "pet_spawn", seat, owner: ownerOfSeatKey(seat) });
};
var seatEndRow = (c) => {
  const seat = seatKey(c.writer, c.op.seat_id);
  c.emit("seat_end", { kind: "pet_poof", seat, owner: ownerOfSeatKey(seat) });
};
var eventRow = (c) => {
  const op = c.op;
  const peer = c.writer.peer;
  switch (op.kind) {
    case "freeze":
      c.emit("freeze", { kind: "person_freeze", peer, reasonCode: op.reason_code });
      return;
    case "unfreeze":
      c.emit("unfreeze", { kind: "person_thaw", peer });
      return;
    case "health":
      if (op.reason_code === HOST_THROTTLED2) c.emit("slowed", { kind: "person_slowed", peer, until: c.height + SLOWED_HEIGHTS });
      else if (op.reason_code === BOARD_FULL_CODE) {
        if (c.scene().badge !== "full") c.emit("board_full", { kind: "room_badge", level: "full" });
      } else c.emit("health_other", { kind: "person_badge", actor: { peer }, badge: "health", on: true, code: op.reason_code });
      return;
    case "nonretryable":
      c.emit("nonretryable", { kind: "person_bang", peer, bang: "host" });
      return;
    case "incident":
      c.unknown();
      return;
    case "breach":
      c.emit("event_breach", { kind: "conflict", conflict: "breach", source: "event", on: { peer }, desk: null, holdId: null, cid: op.cid, eventKind: "breach", line: null });
      return;
    default:
      c.emit("event_k", { kind: "conflict", conflict: "generic", source: "event", on: { peer }, desk: null, holdId: null, cid: op.cid, eventKind: op.kind, line: null });
  }
};
var saveRow = (c) => {
  c.emit("save", { kind: "save", peer: c.writer.peer, desks: c.takeSavedDesks() });
};
var OP_SCENE_ROWS = /* @__PURE__ */ new Map([
  ["join", joinRow],
  ["leave", leaveRow],
  ["caps", () => {
  }],
  ["seat_start", seatStartRow],
  ["seat_end", seatEndRow],
  ["event", eventRow],
  ["save", saveRow]
]);
var ordinaryCode = (c) => {
  const f = c.frame;
  const w = f.writer;
  if (w === null) {
    c.unknown();
    return;
  }
  const seatIds = /* @__PURE__ */ new Set();
  for (const v of f.code.seats) if (v !== "human" && validId("hex128", v)) seatIds.add(v);
  for (const t of f.cs) {
    const a = parseCsActor(t.csId);
    if (a !== null && a.kind === "seat") seatIds.add(a.seat);
  }
  const s = c.scene();
  const spawns = [...seatIds].map((id) => seatKey(w, id)).filter((seat) => s.pets.get(seat)?.live !== true).sort();
  for (const seat of spawns) c.emit("seat_footprint", { kind: "pet_spawn", seat, owner: ownerOfSeatKey(seat) });
  for (const t of f.cs) {
    const actor = actorOfCs(t.csId, w);
    if (actor === null) {
      c.unknown();
      continue;
    }
    const facts = { state: t.state, checks: t.checks, origin: t.origin };
    const paths = f.csPaths.get(t.csId);
    if (paths === void 0) {
      c.emit("publish_big", { kind: "publish", actor, target: BIG_TABLE, others: [], paths: [], n: t.paths, ...facts });
      c.published([BIG_TABLE]);
      continue;
    }
    const desks = [...paths].sort().map((p) => c.desk(p));
    const { target, others } = targetDesk(desks, c.layout(), actorState2(c.scene(), actor)?.lastDesk ?? null);
    c.emit("publish_cs", { kind: "publish", actor, target, others, paths: [...paths], n: t.paths, ...facts });
    c.published([target, ...others]);
  }
  if (f.cs.length === 0) {
    c.emit("publish_nocs", { kind: "publish", actor: { peer: w.peer }, target: BIG_TABLE, others: [], paths: [], n: 0, state: "closed", checks: "skipped", origin: "human" });
    c.published([BIG_TABLE]);
  }
};
var baseMoveCode = (c) => {
  if (!c.frame.ops.some((o) => o.verdict === "effective" && o.type === "save")) c.emit("base_move", { kind: "room_sign", sign: "branch_moved" });
};
var CODE_SCENE_ROWS = /* @__PURE__ */ new Map([
  ["ordinary", ordinaryCode],
  ["base_move", baseMoveCode]
]);
var isBoardFullEvent = (o) => {
  if (o.verdict !== "effective" || o.type !== "event" || o.op === null || typeof o.op !== "object" || Array.isArray(o.op)) return false;
  return o.op["kind"] === "health" && o.op["reason_code"] === BOARD_FULL_CODE;
};
var boardLevelRow = (c) => {
  const rc = c.frame.after.record_count;
  const level = c.scene().badge;
  const next = rc >= BOARD_FULL || level === "full" && c.frame.ops.some(isBoardFullEvent) ? "full" : rc >= BOARD_NEAR_FULL ? "near_full" : "none";
  if (next !== level) c.emit("board_full", { kind: "room_badge", level: next });
};
var DERIVED_ROOM_ROWS = [boardLevelRow];
var ghostRow = (c, a) => {
  if ("peer" in a && c.liveAfter.has(a.peer) && c.rankedBefore.has(a.peer) && !c.rankedAfter.has(a.peer)) c.emit("ghost", { kind: "person_ghost", peer: a.peer });
};
var unghostRow = (c, a) => {
  if ("peer" in a && c.rankedAfter.has(a.peer) && c.liveBefore.has(a.peer) && !c.rankedBefore.has(a.peer)) c.emit("ghost", { kind: "person_unghost", peer: a.peer });
};
var rulesRow = (c, a) => {
  if (!("peer" in a)) return;
  const ch = c.scene().characters.get(a.peer);
  const rules = rulesAfter(c, a.peer);
  if (ch !== void 0 && ch.rules !== rules) c.emit("rules_change", { kind: "person_badge", actor: { peer: a.peer }, badge: "rules", on: rules, code: null });
};
var relaxedRow = (c, a) => {
  const last = actorState2(c.scene(), a)?.lastPublish ?? null;
  if (last !== null && last.height + RELAX_HEIGHTS === c.height) c.emit("relaxed", { kind: "pose_relaxed", actor: "peer" in a ? { peer: a.peer } : { seat: a.seat } });
};
var DERIVED_ACTOR_ROWS = [ghostRow, unghostRow, rulesRow, relaxedRow];
function actorsOf(s) {
  const keys = [];
  for (const peer of s.characters.keys()) keys.push([peer, { peer }]);
  for (const [seat, p] of s.pets) if (p.live) keys.push([seat, { seat }]);
  return keys.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0).map(([, a]) => a);
}
var posOf2 = (p) => ({ height: p.height, sub: p.sub, k: p.k });
function firstAbove2(events, h) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (events[mid].height > h) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function carryOf(t) {
  const last = t.segments.at(-1);
  if (last === void 0) throw new RangeError("TimelineBuilder.resume: a timeline has at least one segment");
  const events = t.segments.length === 1 ? t.events : t.events.slice(firstAbove2(t.events, last.hs));
  const tail = events.at(-1);
  const at = tail !== void 0 && tail.height === t.h1 ? posOf2(tail) : { height: t.h1, sub: 0, k: 0 };
  const scene = reduceScene({ segments: [last], events, layout: t.layout }, at);
  const saved = /* @__PURE__ */ new Set();
  for (const e of events) {
    if (e.kind === "save") saved.clear();
    else if (e.kind === "publish") for (const d of [e.target, ...e.others]) saved.add(d);
  }
  return { scene, savedDesks: [...saved].sort((a, b) => a - b) };
}
var FrameCtx = class {
  frame;
  height;
  writer;
  events = [];
  cards = [];
  unknownCount = 0;
  liveBefore = /* @__PURE__ */ new Set();
  rankedBefore = /* @__PURE__ */ new Set();
  liveAfter = /* @__PURE__ */ new Set();
  rankedAfter = /* @__PURE__ */ new Set();
  b;
  sub = SUB_ROOM;
  k = 0;
  base = "";
  recs = /* @__PURE__ */ new Map();
  constructor(b, frame) {
    this.b = b;
    this.frame = frame;
    this.height = frame.height;
    this.writer = frame.writer;
  }
  /** Later emits go to sub with k from 0, seeded from base. */
  at(sub, base) {
    this.sub = sub;
    this.k = 0;
    this.base = base;
  }
  scene() {
    return this.b.scene();
  }
  layout() {
    return this.b.layout();
  }
  home(peer) {
    this.b.home(peer);
  }
  desk(path2) {
    return this.b.desk(path2, this.height);
  }
  rec(peer) {
    return this.recs.has(peer) ? this.recs.get(peer) : recOf(this.frame.before, peer);
  }
  setRec(peer, rec) {
    this.recs.set(peer, { epoch: rec.epoch, status: rec.status, plugin_version: rec.plugin_version });
  }
  published(desks) {
    this.b.published(desks);
  }
  takeSavedDesks() {
    return this.b.takeSavedDesks();
  }
  unknown() {
    this.unknownCount++;
  }
  emit(row, body) {
    const k = this.k++;
    const e = { ...body, height: this.height, sub: this.sub, k, seed: eventSeed(this.base, k) };
    this.b.apply(e);
    this.events.push(e);
    const card = cardFor(e, row);
    if (card !== null) this.cards.push(card);
  }
  /** The op-row view of one effective op line. */
  forOp(line, op, writer) {
    return {
      frame: this.frame,
      height: this.height,
      line,
      op,
      writer,
      scene: () => this.scene(),
      layout: () => this.layout(),
      home: (p) => this.home(p),
      desk: (p) => this.desk(p),
      rec: (p) => this.rec(p),
      setRec: (p, r) => this.setRec(p, r),
      published: (d) => this.published(d),
      takeSavedDesks: () => this.takeSavedDesks(),
      emit: (row, e) => this.emit(row, e),
      unknown: () => this.unknown()
    };
  }
};
var TimelineBuilder = class _TimelineBuilder {
  lb;
  cached = null;
  reducer;
  view = null;
  saved;
  h0;
  last;
  segments;
  events;
  cards;
  port;
  constructor(o) {
    this.lb = o.lb;
    this.h0 = o.h0;
    this.last = o.h1;
    this.segments = o.segments;
    this.events = o.events;
    this.cards = o.cards;
    this.saved = new Set(o.carry.savedDesks);
    const layoutNow = () => this.cached ??= this.lb.layout();
    this.reducer = new SceneReducer(o.carry.scene, layoutNow);
    this.port = {
      scene: () => this.view ??= this.reducer.scene(),
      layout: layoutNow,
      apply: (e) => {
        this.reducer.push(e);
        this.view = null;
      },
      home: (peer) => {
        if (layoutNow().homeOrder.includes(peer)) return;
        this.lb.home(peer);
        this.cached = null;
      },
      desk: (path2, h) => {
        if (!this.lb.has(path2)) this.cached = null;
        return this.lb.desk(path2, h);
      },
      published: (desks) => {
        for (const d of desks) this.saved.add(d);
      },
      takeSavedDesks: () => {
        const out = [...this.saved].sort((a, b) => a - b);
        this.saved.clear();
        return out;
      }
    };
  }
  /** A new segment at hs = h0 from `start`: the start peers (sorted; every PeerRec, so "load earlier" reveals none) join
   *  homeOrder, then startScene. Frames run from h0 + 1, or from 0 when h0 = 0 (start = initialFoldState). */
  static open(h0, start, layout = emptyLayout()) {
    const lb = new LayoutBuilder(layout);
    for (const peer of Object.keys(start.peers).sort()) lb.home(peer);
    const scene = startScene(start, h0, lb.layout());
    return new _TimelineBuilder({ lb, h0, h1: h0 === 0 ? -1 : h0, segments: [{ hs: h0, start: scene }], events: [], cards: [], carry: { scene, savedDesks: [] } });
  }
  /** Append-only continuation of t (carry recomputed from t's last segment). */
  static resume(t) {
    return new _TimelineBuilder({ lb: new LayoutBuilder(t.layout), h0: t.h0, h1: t.h1, segments: [...t.segments], events: [...t.events], cards: [...t.cards], carry: carryOf(t) });
  }
  /** Re-fold of a range the store dropped: from a kept checkpoint's carry, on a frozen copy of the head layout (a frame that
   *  needs a new desk or home spot throws LayoutFrozenError). frozen = false (Plan 8a Task 8, the room store's live head): an
   *  append-only continuation from the head carry on an unfrozen copy of the current layout — its new desks and home spots
   *  come after every existing one, so the store keeps no long-lived builder (VIZ-41) and desks "load earlier" appended stay
   *  where they are (VIZ-16). The carry is not changed. */
  static replay(carry, layout, frozen = true) {
    const lb = new LayoutBuilder(layout);
    if (frozen) lb.freeze();
    const h = carry.scene.at.height;
    return new _TimelineBuilder({ lb, h0: h, h1: h, segments: [{ hs: h, start: structuredClone(carry.scene) }], events: [], cards: [], carry });
  }
  /** Steps 1–3 of §3.3.5 for one frame; f.height must be h1 + 1. */
  push(f) {
    if (f.height !== this.last + 1) throw new RangeError(`TimelineBuilder.push: a frame at height ${f.height} does not follow height ${this.last}`);
    const c = new FrameCtx(this.port, f);
    const h = f.height;
    const by = `${h}:${f.writer?.peer ?? "-"}:`;
    if (h === 0) {
      c.at(SUB_ROOM, `${by}${SUB_ROOM}`);
      c.emit("genesis", { kind: "room_open" });
    }
    if (f.malformed) c.unknown();
    for (const o of f.ops) {
      const row = o.verdict === "effective" && o.op !== null && f.writer !== null ? OP_SCENE_ROWS.get(o.type) : void 0;
      if (row === void 0) {
        c.unknown();
        continue;
      }
      const op = o.op;
      c.at(1 + o.line, op.id);
      row(c.forOp(o.line, op, f.writer));
    }
    if (h > 0 && f.code.changed) {
      c.at(SUB_CODE, `${by}${SUB_CODE}`);
      const row = f.code.shape === null ? void 0 : CODE_SCENE_ROWS.get(f.code.shape);
      if (row === void 0) c.unknown();
      else row(c);
    }
    c.at(SUB_DERIVED, `${by}${SUB_DERIVED}`);
    c.liveBefore = new Set(liveSet(f.before));
    c.rankedBefore = new Set(rankedSet(f.before));
    c.liveAfter = new Set(liveSet(f.after));
    c.rankedAfter = new Set(rankedSet(f.after));
    for (const row of DERIVED_ROOM_ROWS) row(c);
    for (const a of actorsOf(c.scene())) for (const row of DERIVED_ACTOR_ROWS) row(c, a);
    this.last = h;
    this.events.push(...c.events);
    this.cards.push(...c.cards);
    return { events: c.events, cards: c.cards, layout: this.lb.takeDelta(), unknown: c.unknownCount };
  }
  /** The scene at the segment's last position (the last event of h1, or (h1, 0, 0) with an empty beat when h1 has none) and
   *  the desks published since the segment's last save: copies. */
  carry() {
    const s = this.reducer.scene();
    if (s.at.height < this.last) {
      s.at = { height: this.last, sub: 0, k: 0 };
      s.beat = [];
    }
    return { scene: s, savedDesks: [...this.saved].sort((a, b) => a - b) };
  }
  h1() {
    return this.last;
  }
  /** A snapshot of the whole timeline (a resumed one included): new arrays and layout; events, cards and start scenes shared. */
  timeline() {
    const layout = this.lb.layout();
    return { h0: this.h0, h1: this.last, segments: [...this.segments], events: [...this.events], layout, looks: lookTable(layout.homeOrder), cards: [...this.cards] };
  }
};

// src/viz/source/status.ts
import { join } from "node:path";
var STATUS_MAX_BYTES = 1048576;
var PEER_MAX_BYTES = 4096;
var HEX1282 = /^[0-9a-f]{32}$/;
var REPLACE_ERRORS = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
function codeOf(e) {
  return typeof e === "object" && e !== null ? e.code : void 0;
}
var isStr2 = (v) => typeof v === "string";
var isCount = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
var isMs = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
var isObj3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseStatus(buf) {
  let v;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf));
  } catch {
    return null;
  }
  if (!isObj3(v) || v["v"] !== 1) return null;
  const { state, freeze_reasons: fr, publish_pause: pp, branch, peer_id: peer, plugin_version: pv, heartbeat_mono_ms: hb, loop_period_ms: lp, last_fetch_age_ms: lf, pending } = v;
  if (!isStr2(state) || !Array.isArray(fr) || !fr.every(isStr2) || !(pp === null || isStr2(pp)) || !isStr2(branch) || !isStr2(peer) || !isStr2(pv)) return null;
  if (!isMs(hb) || !isMs(lp) || lp === 0 || !(lf === null || isMs(lf)) || !isObj3(pending)) return null;
  const { cs_ready: ready, holds_active: holds, incoming } = pending;
  if (!isCount(ready) || !isCount(holds) || !isCount(incoming)) return null;
  return {
    state,
    freeze_reasons: [...fr],
    publish_pause: pp,
    branch,
    peer_id: peer,
    plugin_version: pv,
    heartbeat_mono_ms: hb,
    loop_period_ms: lp,
    last_fetch_age_ms: lf,
    pending: { cs_ready: ready, holds_active: holds, incoming }
  };
}
async function readStatus(gitdir, prev, deps) {
  const p = join(gitdir, "cowork", "status.json");
  const kept = prev?.fields ?? null;
  const racing = () => prev ?? { present: true, unreadable: false, mtimeNs: null, fields: null };
  let st;
  try {
    st = await deps.fs.lstat(p);
  } catch (e) {
    if (REPLACE_ERRORS.has(codeOf(e) ?? "")) return racing();
    throw e;
  }
  if (st === null) return { present: false, unreadable: false, mtimeNs: null, fields: kept };
  if (prev !== null && prev.present && prev.mtimeNs !== null && prev.mtimeNs === st.mtimeNs) return prev;
  let r;
  try {
    r = await deps.reader.read(p, STATUS_MAX_BYTES);
  } catch (e) {
    if (REPLACE_ERRORS.has(codeOf(e) ?? "")) return racing();
    throw e;
  }
  if (r === null) return racing();
  const fields = typeof r === "string" ? null : parseStatus(r);
  if (fields === null) return { present: true, unreadable: true, mtimeNs: st.mtimeNs, fields: kept };
  return { present: true, unreadable: false, mtimeNs: st.mtimeNs, fields };
}
async function readPeerFile(gitdir, reader) {
  let r;
  try {
    r = await reader.read(join(gitdir, "cowork", "peer"), PEER_MAX_BYTES);
  } catch {
    return null;
  }
  if (r === null || typeof r === "string") return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r).trim();
  } catch {
    return null;
  }
  return HEX1282.test(text) ? text : null;
}
function youOf(peerFile, s) {
  if (peerFile !== null) return peerFile;
  const id = s?.fields?.peer_id;
  return id !== void 0 && HEX1282.test(id) ? id : null;
}
function overlayOf(s, nowMachineMono, viewerVersion, you) {
  const f = s.fields;
  const stale = f !== null && (nowMachineMono - f.heartbeat_mono_ms > 3 * f.loop_period_ms || f.heartbeat_mono_ms > nowMachineMono + f.loop_period_ms);
  const down = !s.present || !s.unreadable && f !== null && (f.state === "down" || stale);
  const offlineMin = f !== null && f.state === "offline" && f.last_fetch_age_ms !== null ? Math.floor((f.last_fetch_age_ms + Math.max(0, nowMachineMono - f.heartbeat_mono_ms)) / 6e4) : null;
  return {
    state: f?.state ?? (s.present ? "?" : "down"),
    freezeReasons: f === null ? [] : [...f.freeze_reasons],
    publishPause: f?.publish_pause ?? null,
    down,
    unreadable: s.present && s.unreadable,
    offlineMin,
    holds: f?.pending.holds_active ?? 0,
    incoming: f?.pending.incoming ?? 0,
    ready: f?.pending.cs_ready ?? 0,
    you,
    versionSkew: f !== null && f.plugin_version !== viewerVersion
  };
}

// src/viz/server/store.ts
var RETAIN_HEIGHTS = 2048;
var PAGE_HEIGHTS = 256;
var SNAPSHOT_AFTER = 64;
var LAST_CARDS = 200;
var WINDOW_BELOW = 1023;
var BADGE_ORDER = ["UI_VIZ_VERSION_SKEW", "UI_VIZ_NEWER_PROTOCOL", "UI_VIZ_CHECKPOINT_MISMATCH", "UI_VIZ_INCIDENT_FROZEN", "UI_VIZ_NO_BOARD"];
var NOT_READ = { present: true, unreadable: false, mtimeNs: null, fields: null };
function glyphOf(e) {
  switch (e.kind) {
    case "publish":
      return "publish";
    case "conflict":
      return "conflict";
    case "request_open":
      return "request";
    case "save":
      return "save";
    case "person_enter":
    case "person_respawn":
    case "person_exit":
      return "door";
    case "person_freeze":
      return "freeze";
    default:
      return null;
  }
}
function ticksOf(events) {
  const out = [];
  for (const e of events) {
    const glyph = glyphOf(e);
    if (glyph !== null) out.push({ h: e.height, glyph });
  }
  return out;
}
function firstAbove3(list, h, heightOf) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (heightOf(list[mid]) > h) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
var eventHeight = (e) => e.height;
var cardHeight = (c) => c.at.height;
var between = (list, lo, hi, heightOf) => list.slice(firstAbove3(list, lo, heightOf), firstAbove3(list, hi, heightOf));
function layoutDelta(a, b) {
  if (b.version === a.version) return null;
  return {
    fromVersion: a.version,
    version: b.version,
    zones: b.zones.filter((z, i) => i >= a.zones.length || z.cells.length !== a.zones[i].cells.length).map((z) => ({ index: z.index, key: z.key, cells: [...z.cells] })),
    desks: b.desks.slice(a.desks.length),
    homeOrder: b.homeOrder.slice(a.homeOrder.length)
  };
}
function sceneAtEnd(start, events, layout, h) {
  const r = new SceneReducer(start, () => layout);
  for (const e of events) {
    if (e.height > h) break;
    r.push(e);
  }
  const s = r.scene();
  if (s.at.height < h) {
    s.at = { height: h, sub: 0, k: 0 };
    s.beat = [];
  }
  return s;
}
function peerInfos(s) {
  const out = /* @__PURE__ */ new Map();
  for (const peer of Object.keys(s.peers).sort()) {
    const r = s.peers[peer];
    out.set(peer, { display: r.display, pluginVersion: r.plugin_version, status: r.status });
  }
  return out;
}
function petInfos(s) {
  const out = /* @__PURE__ */ new Map();
  for (const seat of [...s.pets.keys()].sort()) {
    const p = s.pets.get(seat);
    out.set(seat, { owner: p.owner, live: p.live, ssCode: p.ssCode, variant: p.variant });
  }
  return out;
}
function changedOnly(before, after) {
  const out = /* @__PURE__ */ new Map();
  for (const [k, v] of after) {
    const was = before.get(k);
    if (was === void 0 || JSON.stringify(was) !== JSON.stringify(v)) out.set(k, v);
  }
  return out;
}
async function foldRun(b, frames, keep, each) {
  const run = { events: [], cards: [], unknown: 0, points: [], protoMismatch: false, mismatch: false, last: null };
  try {
    for await (const f of frames) {
      const o = b.push(f);
      for (const e of o.events) run.events.push(e);
      for (const c of o.cards) run.cards.push(c);
      run.unknown += o.unknown;
      if (f.protoMismatch) run.protoMismatch = true;
      if (f.checkpoint === "mismatch") run.mismatch = true;
      if (f.height % CHECKPOINT_EVERY === 0 && keep(f.height)) run.points.push({ h: f.height, state: f.after, carry: b.carry() });
      run.last = f;
      each?.(f);
    }
    return { run, error: null };
  } catch (e) {
    return { run, error: e };
  }
}
var RoomStore = class {
  ready;
  spec;
  source;
  deps;
  markReady = () => {
  };
  started = null;
  queue = Promise.resolve();
  win = null;
  /** The room's badges, one set (Task 20 adds UI_VIZ_CLAIMS_PENDING to it): VERSION_SKEW from the overlay, NEWER_PROTOCOL and
   *  CHECKPOINT_MISMATCH latched by any frame of the window (a rebuild clears them), INCIDENT_FROZEN, NO_BOARD. */
  badges = /* @__PURE__ */ new Set();
  gone = false;
  frozen = false;
  /** The last parsed heartbeat when the room froze: a rebuild needs a newer one (VIZ-14). */
  freezeHeartbeat = Number.NEGATIVE_INFINITY;
  /** A tip the last fold did not reach (a missing object, R-V19): folded towards again next tick without waiting for changed(). */
  pending = null;
  /** The last window build failed after the tip resolved: built again next tick. */
  retryBuild = false;
  status = null;
  peerFile = null;
  overlay = null;
  overlayKey = "";
  /** The room header (badges, gone, unknown) as last reported; a tick reports 'state' when it differs. */
  reported = "";
  constructor(spec, source, deps) {
    this.spec = spec;
    this.source = source;
    this.deps = deps;
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }
  /** The first window (VIZ-09): never rejects — a missing board, a git failure or an incident state leave an empty room with its
   *  badge, and `ready` resolves either way. Idempotent. */
  init() {
    this.started ??= this.exclusive(() => this.initNow()).then(() => this.markReady(), () => this.markReady());
    return this.started;
  }
  async tick() {
    await this.init();
    return this.exclusive(() => this.tickNow());
  }
  async page(from, to) {
    await this.init();
    return this.exclusive(() => this.pageNow(from, to));
  }
  async earlier() {
    await this.init();
    return this.exclusive(async () => {
      const w = this.win;
      if (w === null) return null;
      const x = await this.extend(w);
      if (x === null) return null;
      const f = firstHeight(w.h0);
      const p = await this.servePage(w, f, f + PAGE_HEIGHTS - 1, x.fresh);
      return p === null ? null : { ...p, layout: x.layout };
    });
  }
  snapshot() {
    const w = this.win;
    const common = { spec: this.spec, gone: this.gone, badges: this.badgeList(), overlay: this.overlay };
    if (w === null) {
      return {
        ...common,
        window: { h0: 0, h1: 0 },
        unknown: 0,
        layout: emptyLayout(),
        looks: /* @__PURE__ */ new Map(),
        peers: /* @__PURE__ */ new Map(),
        pets: /* @__PURE__ */ new Map(),
        scene: emptyScene({ height: 0, sub: 0, k: 0 }),
        cards: [],
        ticks: []
      };
    }
    return {
      ...common,
      window: { h0: w.h0, h1: w.h1 },
      unknown: w.unknown,
      layout: w.layout,
      looks: lookTable(w.layout.homeOrder),
      peers: peerInfos(w.head.state),
      pets: petInfos(w.head.carry.scene),
      scene: w.head.carry.scene,
      cards: this.lastCards(w),
      ticks: [...w.ticks]
    };
  }
  // ---- the operations, one at a time ------------------------------------------------------------------------------------
  exclusive(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => void 0, () => void 0);
    return next;
  }
  async initNow() {
    const gitDir = this.spec.gitDir;
    if (gitDir !== null) this.peerFile = await readPeerFile(gitDir, this.deps.reader);
    await this.refreshLocal();
    if (this.status?.fields?.state === "incident") this.freeze();
    else await this.build(emptyLayout());
    this.reported = this.header();
  }
  /** One poll step (12 §3.9.2): the local status, then the board — unless the room is gone or frozen. */
  async tickNow() {
    const overlay = await this.refreshLocal();
    let delta = null;
    let rebuilt = false;
    if (!this.gone && await this.gitDirGone()) this.gone = true;
    if (!this.gone) {
      if (this.frozen) {
        if (this.thawed()) rebuilt = await this.build(this.win?.layout ?? emptyLayout());
      } else if (this.status?.fields?.state === "incident") {
        this.freeze();
      } else if (this.win === null) {
        if (this.retryBuild || await this.changed()) rebuilt = await this.build(emptyLayout());
      } else {
        delta = await this.follow(this.win);
      }
    }
    const header = this.header();
    const change = rebuilt ? "rebuilt" : header !== this.reported ? "state" : null;
    this.reported = header;
    return { delta, overlay, change };
  }
  /** The window for the current tip on `layout` (R-V21: a rebuild keeps the desks), swapped in whole on success. */
  async build(layout) {
    try {
      const tip = await this.source.tip();
      this.retryBuild = false;
      if (tip === null) {
        this.badges.add("UI_VIZ_NO_BOARD");
        return false;
      }
      const { w, run } = await this.window(tip, layout);
      this.win = w;
      this.frozen = false;
      this.pending = null;
      for (const b of ["UI_VIZ_INCIDENT_FROZEN", "UI_VIZ_NO_BOARD", "UI_VIZ_NEWER_PROTOCOL", "UI_VIZ_CHECKPOINT_MISMATCH"]) this.badges.delete(b);
      this.latch(run);
      return true;
    } catch (e) {
      this.noBoard(e);
      this.retryBuild = true;
      return false;
    }
  }
  /** VIZ-09: h0 = 256 · ⌊max(0, t − 1,023) / 256⌋; from initialFoldState at 0 (frames from 0), else from the checkpoint at h0. */
  async window(tip, layout) {
    const h0 = CHECKPOINT_EVERY * Math.floor(Math.max(0, tip.height - WINDOW_BELOW) / CHECKPOINT_EVERY);
    const start = await this.source.startAt(h0);
    const b = TimelineBuilder.open(h0, start, layout);
    const startCarry = b.carry();
    const { run, error } = await foldRun(b, this.source.frames(start, h0 === 0 ? 0 : h0 + 1, tip.height, this.self()), () => true);
    if (error !== null) throw error;
    if ((run.last?.height ?? start.height) !== tip.height) throw new RangeError(`RoomStore: the window of a tip at ${tip.height} ended at ${run.last?.height ?? start.height}`);
    const w = {
      h0,
      h1: tip.height,
      layout: b.timeline().layout,
      points: [{ h: start.height, state: start, carry: startCarry }, ...run.points],
      lo: start.height,
      events: run.events,
      cards: run.cards,
      ticks: ticksOf(run.events),
      anchors: /* @__PURE__ */ new Map(),
      unknown: run.unknown,
      head: { state: run.last?.after ?? start, carry: b.carry(), tip }
    };
    retain(w);
    return { w, run };
  }
  /** NEWER_PROTOCOL and CHECKPOINT_MISMATCH from a run's frames (12 §3.3.3 "Version coupling", "Checkpoints"): display only. */
  latch(run) {
    if (run.protoMismatch) this.badges.add("UI_VIZ_NEWER_PROTOCOL");
    if (run.mismatch) this.badges.add("UI_VIZ_CHECKPOINT_MISMATCH");
  }
  /** changed() → advance() (R-V31) → fold a fast-forward; a pending tip is folded towards without waiting for changed(). */
  async follow(w) {
    try {
      let target;
      if (await this.changed()) {
        const a = await this.source.advance(w.head.tip);
        if (a.kind === "none") {
          this.pending = null;
          this.badges.delete("UI_VIZ_NO_BOARD");
          return null;
        }
        if (a.kind === "gone") {
          this.pending = null;
          this.badges.add("UI_VIZ_NO_BOARD");
          return null;
        }
        if (a.kind === "rewrite") {
          this.freeze();
          return null;
        }
        target = a.to;
      } else if (this.pending !== null) {
        target = this.pending;
      } else {
        return null;
      }
      return await this.fastForward(w, target);
    } catch (e) {
      this.noBoard(e);
      return null;
    }
  }
  /** Folds h1 + 1 … target onto the head (every height folded here gets its seen anchor, R-V28); what folded before a failure is
   *  kept, the rest stays pending (R-V19). > SNAPSHOT_AFTER heights → one snapshot delta. */
  async fastForward(w, target) {
    const layout0 = w.layout, peers0 = peerInfos(w.head.state), pets0 = petInfos(w.head.carry.scene), h1 = w.h1;
    const b = TimelineBuilder.replay(w.head.carry, w.layout, false);
    const anchors = [];
    const { run, error } = await foldRun(
      b,
      this.source.frames(w.head.state, w.h1 + 1, target.height, this.self()),
      () => true,
      (f) => anchors.push([f.height, this.deps.clock.monoMs()])
    );
    const last = run.last;
    if (last !== null) {
      w.h1 = last.height;
      w.layout = b.timeline().layout;
      w.head = { state: last.after, carry: b.carry(), tip: last.height === target.height ? target : { height: last.height, key: last.oid } };
      w.events = w.events.concat(run.events);
      w.cards = w.cards.concat(run.cards);
      w.ticks = w.ticks.concat(ticksOf(run.events));
      w.points = w.points.concat(run.points);
      for (const [h, at] of anchors) w.anchors.set(h, at);
      w.unknown += run.unknown;
      this.latch(run);
      retain(w);
    }
    if (error !== null) {
      this.pending = target;
      this.noBoard(error);
    } else {
      this.pending = null;
      this.badges.delete("UI_VIZ_NO_BOARD");
    }
    if (last === null) return null;
    const base = {
      roomId: this.spec.id,
      window: { h0: w.h0, h1: w.h1 },
      layout: layoutDelta(layout0, w.layout),
      peers: changedOnly(peers0, peerInfos(w.head.state)),
      pets: changedOnly(pets0, petInfos(w.head.carry.scene))
    };
    if (w.h1 - h1 > SNAPSHOT_AFTER) return { ...base, kind: "snapshot", events: [], cards: this.lastCards(w), ticks: [...w.ticks], scene: w.head.carry.scene };
    return { ...base, kind: "timeline", events: run.events, cards: run.cards.map((c) => this.model(w, c)), ticks: ticksOf(run.events), scene: null };
  }
  /** "Load earlier" (R-V29): one segment of 256 below h0 on the current layout, its new desks as one layout delta; no anchor. */
  async extend(w) {
    if (w.h0 === 0 || this.frozen) return null;
    const hs = w.h0, h0 = hs - PAGE_HEIGHTS;
    try {
      const start = await this.source.startAt(h0);
      const b = TimelineBuilder.open(h0, start, w.layout);
      const startCarry = b.carry();
      const { run, error } = await foldRun(b, this.source.frames(start, h0 === 0 ? 0 : h0 + 1, hs, this.self()), (h) => h < hs);
      if (error !== null) throw error;
      if (run.last?.height !== hs) throw new RangeError(`RoomStore: the segment below ${hs} ended at ${run.last?.height ?? start.height}`);
      const layout = b.timeline().layout;
      const delta = layoutDelta(w.layout, layout);
      w.h0 = h0;
      w.layout = layout;
      w.points = [{ h: start.height, state: start, carry: startCarry }, ...run.points, ...w.points];
      w.ticks = ticksOf(run.events).concat(w.ticks);
      w.unknown += run.unknown;
      this.latch(run);
      const lo = retainedFrom(w);
      if (lo < w.lo) {
        w.events = between(run.events, lo, hs, eventHeight).concat(w.events);
        w.cards = between(run.cards, lo, hs, cardHeight).concat(w.cards);
        w.lo = lo;
      }
      return { fresh: { c0: start.height, end: hs, events: run.events, cards: run.cards }, layout: delta };
    } catch (e) {
      this.log(() => this.deps.log.error("UI_VIZ_NO_BOARD", e));
      return null;
    }
  }
  /** 12 §3.10.5: a `from` below the window's first height (h0 + 1; height h0 belongs to the segment below) extends the window by one
   *  segment and answers its page from max(from, its first height) (R-V29; a `to` below that reads as the segment's page); otherwise
   *  the page as asked. */
  async pageNow(from, to) {
    const w = this.win;
    if (w === null || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0) return null;
    if (from >= firstHeight(w.h0)) return this.servePage(w, from, to, null);
    const x = await this.extend(w);
    if (x === null) return null;
    const f = Math.max(from, firstHeight(w.h0));
    const p = await this.servePage(w, f, to < f ? f + PAGE_HEIGHTS - 1 : to, x.fresh);
    return p === null ? null : { ...p, layout: x.layout };
  }
  /**
   * The page [from, to] of the window (from at or above its first height), to clipped at h1, at 256 heights and at the next segment
   * start — every checkpoint height, so a page holds heights of one segment (hs, hs + 256] only (glossary "segment"). Its scene: the
   * segment's start scene when from is the segment's first height (hs + 1, or 0 for the genesis segment), else the scene at the last
   * position of from − 1 (12 §3.10.6). Served from memory when every event it needs is kept, else re-folded from the kept point c at
   * or below from − 1: the frames c + 1 … to, at most 256 folds and at most 255 before from (VIZ-26), on a frozen copy of the head
   * layout, with the stored seen anchors (R-V28). Never while frozen.
   */
  async servePage(w, from, to, fresh) {
    if (from < firstHeight(w.h0) || from > w.h1 || to < from) return null;
    const next = from === 0 ? PAGE_HEIGHTS : PAGE_HEIGHTS * Math.ceil(from / PAGE_HEIGHTS);
    to = Math.min(to, w.h1, from + PAGE_HEIGHTS - 1, next);
    const c = pointFor(w, from);
    let events;
    let cards;
    if (fresh !== null && c.h >= fresh.c0 && to <= fresh.end) {
      events = between(fresh.events, c.h, to, eventHeight);
      cards = between(fresh.cards, c.h, to, cardHeight);
    } else if (c.h >= w.lo) {
      events = between(w.events, c.h, to, eventHeight);
      cards = between(w.cards, c.h, to, cardHeight);
    } else {
      if (this.frozen) return null;
      const b = c.h < 0 ? TimelineBuilder.open(0, c.state, w.layout) : TimelineBuilder.replay(c.carry, w.layout);
      const { run, error } = await foldRun(b, this.source.frames(c.state, c.h + 1, to, this.self()), () => false);
      if (error !== null) {
        this.log(() => this.deps.log.error("UI_VIZ_NO_BOARD", error));
        return null;
      }
      events = run.events;
      cards = run.cards;
    }
    const scene = sceneAtEnd(c.carry.scene, events, w.layout, from - 1);
    return {
      roomId: this.spec.id,
      from,
      to,
      scene,
      events: events.slice(firstAbove3(events, from - 1, eventHeight)),
      cards: cards.slice(firstAbove3(cards, from - 1, cardHeight)).map((k) => this.model(w, k)),
      layout: null
    };
  }
  // ---- local status, badges, freezing ----------------------------------------------------------------------------------
  /** status.json on mtime change (12 §3.3.6) and the overlay; the overlay when it differs from the last one, else null. Demo rooms
   *  read nothing and have none. */
  async refreshLocal() {
    const gitDir = this.spec.gitDir;
    if (gitDir === null) return null;
    try {
      this.status = await readStatus(gitDir, this.status, this.deps);
    } catch (e) {
      this.log(() => this.deps.log.error("UI_VIZ_STATUS_UNREADABLE", e));
    }
    const o = overlayOf(this.status ?? NOT_READ, this.deps.machineMonoMs(), this.deps.viewerVersion, youOf(this.peerFile, this.status));
    if (o.versionSkew) this.badges.add("UI_VIZ_VERSION_SKEW");
    else this.badges.delete("UI_VIZ_VERSION_SKEW");
    const key = JSON.stringify(o);
    if (key === this.overlayKey) return null;
    this.overlay = o;
    this.overlayKey = key;
    return o;
  }
  /** The source's change trigger (no git while the stat pairs are unchanged); a failure counts as a change. */
  async changed() {
    try {
      return await this.source.changed();
    } catch {
      return true;
    }
  }
  /** 12 §6: the gitdir moved or was deleted — the room greys out and keeps its history (no git call follows). */
  async gitDirGone() {
    const gitDir = this.spec.gitDir;
    if (gitDir === null) return false;
    try {
      return await this.deps.fs.lstat(gitDir) === null;
    } catch {
      return false;
    }
  }
  /** VIZ-14: stop folding at the last folded scene. */
  freeze() {
    if (!this.frozen) this.log(() => this.deps.log.write("UI_VIZ_INCIDENT_FROZEN"));
    this.frozen = true;
    this.freezeHeartbeat = this.status?.fields?.heartbeat_mono_ms ?? Number.NEGATIVE_INFINITY;
    this.pending = null;
    this.retryBuild = false;
    this.badges.add("UI_VIZ_INCIDENT_FROZEN");
  }
  /** VIZ-14: the room's daemon reports another state than incident, with a heartbeat newer than the one at the freeze that is fresh
   *  by 12 §3.3.6 (the overlay is not down). */
  thawed() {
    const f = this.status?.fields ?? null;
    return f !== null && f.state !== "incident" && f.heartbeat_mono_ms > this.freezeHeartbeat && this.overlay !== null && !this.overlay.down;
  }
  /** R-V19, 12 §6: a missing board or live object, a vanished ref, a git failure — the last scene stays; retried next tick. */
  noBoard(e) {
    this.badges.add("UI_VIZ_NO_BOARD");
    this.log(() => this.deps.log.error("UI_VIZ_NO_BOARD", e));
  }
  /** R-V46: the fold's self — the peer file, else status.json's peer_id, else zeros (the timeline does not depend on it). */
  self() {
    return youOf(this.peerFile, this.status) ?? ZERO_PEER;
  }
  badgeList() {
    return BADGE_ORDER.filter((b) => this.badges.has(b));
  }
  header() {
    return JSON.stringify([this.badgeList(), this.gone, this.win?.unknown ?? 0]);
  }
  model(w, card) {
    return { card, foldedAt: w.anchors.get(card.at.height) ?? null };
  }
  lastCards(w) {
    return w.cards.slice(-LAST_CARDS).map((c) => this.model(w, c));
  }
  /** Logging never breaks a tick. */
  log(fn) {
    try {
      fn();
    } catch {
    }
  }
};
function retainedFrom(w) {
  const floor = w.h1 - RETAIN_HEIGHTS;
  for (const p of w.points) if (p.h >= floor) return p.h;
  return floor;
}
function retain(w) {
  const lo = retainedFrom(w);
  if (lo <= w.lo) return;
  w.events = w.events.slice(firstAbove3(w.events, lo, eventHeight));
  w.cards = w.cards.slice(firstAbove3(w.cards, lo, cardHeight));
  w.lo = lo;
}
function firstHeight(h0) {
  return h0 === 0 ? 0 : h0 + 1;
}
function pointFor(w, from) {
  let c = w.points[0];
  for (const p of w.points) if (p.h <= from - 1) c = p;
  return c;
}

// src/viz/server/tokens.ts
import crypto from "node:crypto";
var LAUNCH_TTL_MS = 12e4;
var TOKEN_RE = /^[0-9a-f]{64}$/;
var TOKEN_BYTES = 32;
var INSTANCE_BYTES = 5;
function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest();
}
function tokenEquals(presented, expected) {
  if (typeof presented !== "string" || !TOKEN_RE.test(presented)) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(expected));
}
var TokenAuthority = class {
  launch;
  instance;
  clock;
  anchor;
  /** Minted at construction, handed out by the one successful redemption. */
  session;
  redeemedOnce = false;
  revoked = false;
  /** launch and session: 32 bytes each from random; instance: 8 base32c characters. The TTL anchor is taken here. */
  constructor(random, clock) {
    this.launch = randomHex(random, TOKEN_BYTES);
    this.session = randomHex(random, TOKEN_BYTES);
    this.instance = base32c(random.bytes(INSTANCE_BYTES));
    this.clock = clock;
    this.anchor = anchorNow(clock);
  }
  /** Single use within 120 s own staleness; a second presentation → 'reused' and the session is revoked. Order: shape, mismatch,
   *  reused (a redeemed token has no TTL left to judge), expired. */
  redeem(presented) {
    if (presented === void 0 || !TOKEN_RE.test(presented)) return { ok: false, why: "shape" };
    if (!tokenEquals(presented, this.launch)) return { ok: false, why: "mismatch" };
    if (this.redeemedOnce) {
      this.revoked = true;
      return { ok: false, why: "reused" };
    }
    if (this.launchExpired()) return { ok: false, why: "expired" };
    this.redeemedOnce = true;
    return { ok: true, session: this.session, instance: this.instance };
  }
  /** True only for the session minted by the one redemption, until a reuse revokes it. */
  checkSession(presented) {
    if (!this.redeemedOnce || this.revoked || presented === void 0) return false;
    return tokenEquals(presented, this.session);
  }
  /** The launch token's 120 s are over (own staleness from construction). */
  launchExpired() {
    return ownStaleness(this.clock, this.anchor) > LAUNCH_TTL_MS;
  }
  redeemed() {
    return this.redeemedOnce;
  }
};

// src/viz/source/boundedRead.ts
import { constants, promises as fsp2 } from "node:fs";
var NOFOLLOW = constants.O_NOFOLLOW;
var NONBLOCK = constants.O_NONBLOCK;
var OPEN_FLAGS = constants.O_RDONLY | (NOFOLLOW ?? 0) | (NONBLOCK ?? 0);
function codeOf2(e) {
  return typeof e === "object" && e !== null ? e.code : void 0;
}
function checkMax(max) {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError(`BoundedReader: max must be a non-negative integer, got ${String(max)}`);
}
var realBoundedReader = {
  async read(path2, max) {
    checkMax(max);
    if (NOFOLLOW === void 0) {
      let l;
      try {
        l = await fsp2.lstat(path2);
      } catch (e) {
        if (codeOf2(e) === "ENOENT" || codeOf2(e) === "ENOTDIR") return null;
        throw e;
      }
      if (l.isSymbolicLink() || !l.isFile()) return "not_file";
    }
    let h;
    try {
      h = await fsp2.open(path2, OPEN_FLAGS);
    } catch (e) {
      const code = codeOf2(e);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      if (code === "ELOOP" || code === "EMLINK" || code === "EISDIR") return "not_file";
      throw e;
    }
    try {
      if (!(await h.stat()).isFile()) return "not_file";
      const buf = Buffer.alloc(max + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await h.read(buf, n, buf.length - n, null);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      if (n > max) return "too_large";
      return Buffer.from(buf.subarray(0, n));
    } finally {
      await h.close();
    }
  }
};

// src/viz/source/demo.ts
import { createHash as createHash5 } from "node:crypto";
var DEMO_FORMAT = "cowork-viz-demo/1";
var DEMO_MAX_BYTES = 4 * 1024 * 1024;
var BUNDLED_DEMO_MAX_BYTES = 64 * 1024;
var CAPTION_TEXT_MAX = 120;
var ROOMS_MAX = 32;
var ROOM_RE = /^[a-z0-9]{1,8}$/;
var NAME_MAX = 40;
var BRANCH_MAX = 80;
var CS_PATHS_MAX2 = 256;
var CAPTION_CODE_RE = /^UI_VIZ_DEMO_CAPTION_[0-9]{1,2}$/;
var CLAIM_TREES_MAX = 1e3;
var CLAIM_PAIRS_MAX = 4096;
var CLAIM_ID_RE = /^[a-z2-7]{16}$/;
var ABSENT = "ABSENT";
var BOM = Buffer.from([239, 187, 191]);
var HEADER_KEYS = ["t", "format", "rooms"];
var ROOM_KEYS = ["room", "name", "branch"];
var COMMIT_KEYS = /* @__PURE__ */ new Set(["t", "room", "height", "writer", "protocol", "code", "cs", "csPaths", "ops", "held", "live", "claims"]);
var COMMIT_REQUIRED = ["t", "room", "height", "writer", "code", "cs", "csPaths", "ops"];
var CAPTION_KEYS = /* @__PURE__ */ new Set(["t", "room", "height", "code", "text"]);
var PROTOCOL_KEYS = ["proto", "regionSpec", "budget", "G_s", "S_s"];
var CODE_KEYS = ["changed", "seats", "base"];
var CLAIMS_KEYS = ["trees", "pairs"];
var Refusal = class {
  constructor(line) {
    this.line = line;
  }
};
function refuse3(line) {
  throw new Refusal(line);
}
var isObj4 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var has2 = (o, k) => Object.hasOwn(o, k);
var isStr3 = (v) => typeof v === "string";
var chars = (s) => [...s].length;
var exactKeys = (o, keys) => {
  const own2 = Object.keys(o);
  return own2.length === keys.length && keys.every((k) => has2(o, k));
};
var byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
var sha1 = (s) => createHash5("sha1").update(s, "utf8").digest("hex");
function splitLines(buf) {
  const out = [];
  let pos2 = 0;
  while (pos2 < buf.length) {
    const lf = buf.indexOf(10, pos2);
    const end = lf < 0 ? buf.length : lf;
    out.push(buf.subarray(pos2, end));
    pos2 = end + 1;
  }
  return out;
}
function record(bytes2, n) {
  if (bytes2.includes(13) || bytes2.includes(BOM)) refuse3(n);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes2);
  } catch {
    return refuse3(n);
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return refuse3(n);
  }
  if (!isObj4(v)) refuse3(n);
  return v;
}
function parseHeader(r, n) {
  if (!exactKeys(r, HEADER_KEYS) || r["format"] !== DEMO_FORMAT) refuse3(n);
  const rooms = r["rooms"];
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > ROOMS_MAX) refuse3(n);
  const seen = /* @__PURE__ */ new Set();
  return rooms.map((x) => {
    if (!isObj4(x) || !exactKeys(x, ROOM_KEYS)) refuse3(n);
    const { room, name, branch } = x;
    if (!isStr3(room) || !ROOM_RE.test(room) || seen.has(room)) refuse3(n);
    if (!isStr3(name) || chars(name) < 1 || chars(name) > NAME_MAX || !isStr3(branch) || chars(branch) < 1 || chars(branch) > BRANCH_MAX) refuse3(n);
    seen.add(room);
    return { room, name, branch };
  });
}
function parseProtocol(v, n) {
  if (!isObj4(v) || !exactKeys(v, PROTOCOL_KEYS)) refuse3(n);
  const { proto, regionSpec, budget: budget2, G_s: g, S_s: s } = v;
  const positive2 = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (typeof proto !== "number" || !Number.isSafeInteger(proto) || proto < 0 || !isStr3(regionSpec) || !positive2(budget2) || !positive2(g) || !positive2(s)) refuse3(n);
  return { proto, regionSpec, budget: budget2, G_s: g, S_s: s };
}
function csTrailerOf(v) {
  if (!isStr3(v)) return null;
  const { cs } = parseCsTrailers([{ key: "Cowork-CS", value: v }]);
  return cs.length === 1 ? cs[0] : null;
}
var pairId = (v) => isStr3(v) && (validId("op", v) || CLAIM_ID_RE.test(v));
function parseClaims(v, n) {
  if (!isObj4(v) || !exactKeys(v, CLAIMS_KEYS)) refuse3(n);
  const { trees, pairs } = v;
  if (!Array.isArray(trees) || trees.length > CLAIM_TREES_MAX || !Array.isArray(pairs) || pairs.length > CLAIM_PAIRS_MAX) refuse3(n);
  const treeKeys = /* @__PURE__ */ new Set();
  const outTrees = trees.map((t) => {
    if (!Array.isArray(t) || t.length !== 3) refuse3(n);
    const [commit, path2, entry] = t;
    if (!isOid(commit) || !isStr3(path2) || !validPathSyntax(path2) || !(entry === ABSENT || isOid(entry))) refuse3(n);
    const key = `${commit}\0${path2}`;
    if (treeKeys.has(key)) refuse3(n);
    treeKeys.add(key);
    return [commit, path2, entry];
  });
  const pairKeys = /* @__PURE__ */ new Set();
  const outPairs = pairs.map((p) => {
    if (!Array.isArray(p) || p.length !== 3) refuse3(n);
    const [c1, c2, overlap] = p;
    if (!pairId(c1) || !pairId(c2) || typeof overlap !== "boolean") refuse3(n);
    const key = `${c1}\0${c2}`;
    if (pairKeys.has(key)) refuse3(n);
    pairKeys.add(key);
    return [c1, c2, overlap];
  });
  return { trees: outTrees, pairs: outPairs };
}
function parseCommit(r, n, commits) {
  for (const k of Object.keys(r)) if (!COMMIT_KEYS.has(k)) refuse3(n);
  for (const k of COMMIT_REQUIRED) if (!has2(r, k)) refuse3(n);
  const room = r["room"];
  const list = isStr3(room) ? commits.get(room) : void 0;
  if (list === void 0) return refuse3(n);
  const height = r["height"];
  if (typeof height !== "number" || height !== list.length) refuse3(n);
  const writer = r["writer"];
  if (!(writer === null || isStr3(writer) && parseWriter(writer) !== null)) refuse3(n);
  if (has2(r, "protocol") !== (height === 0)) refuse3(n);
  const protocol = height === 0 ? parseProtocol(r["protocol"], n) : null;
  const code = r["code"];
  if (!isObj4(code) || !exactKeys(code, CODE_KEYS)) return refuse3(n);
  const { changed, seats, base } = code;
  if (typeof changed !== "boolean" || !Array.isArray(seats) || !seats.every(isStr3) || !(base === null || isOid(base))) refuse3(n);
  const cs = r["cs"];
  if (!Array.isArray(cs)) return refuse3(n);
  const csIds = /* @__PURE__ */ new Set();
  for (const v of cs) {
    const t = csTrailerOf(v);
    if (t === null) refuse3(n);
    csIds.add(t.csId);
  }
  const rawPaths = r["csPaths"];
  if (!isObj4(rawPaths)) return refuse3(n);
  const csPaths = /* @__PURE__ */ new Map();
  for (const key of Object.keys(rawPaths)) {
    if (!csIds.has(key)) refuse3(n);
    const paths = rawPaths[key];
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > CS_PATHS_MAX2) refuse3(n);
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (!isStr3(p) || !validPathSyntax(p) || i > 0 && byUtf8(paths[i - 1], p) >= 0) refuse3(n);
    }
    csPaths.set(key, [...paths]);
  }
  const ops = r["ops"];
  if (!Array.isArray(ops) || ops.length > OPS_MAX_LINES) return refuse3(n);
  let bytes2 = 0;
  for (const o of ops) {
    if (!isStr3(o)) refuse3(n);
    const b = Buffer.byteLength(o, "utf8");
    bytes2 += b + 1;
    if (b > OP_MAX_LINE_BYTES || bytes2 > OPS_MAX_BYTES) refuse3(n);
  }
  const held = has2(r, "held") ? r["held"] : [];
  if (!Array.isArray(held) || !held.every(isStr3)) return refuse3(n);
  let live = null;
  if (has2(r, "live")) {
    const l = r["live"];
    if (!isOid(l) || changed !== true) refuse3(n);
    live = l;
  }
  const claims = has2(r, "claims") ? parseClaims(r["claims"], n) : null;
  return {
    room,
    height,
    writer,
    protocol,
    code: { changed, seats: [...seats], base },
    cs: [...cs],
    csPaths,
    ops: [...ops],
    held: [...held],
    live,
    claims,
    line: n
  };
}
function parseCaption(r, n, commits, captionCodes) {
  for (const k of Object.keys(r)) if (!CAPTION_KEYS.has(k)) refuse3(n);
  if (!has2(r, "room") || !has2(r, "height") || has2(r, "code") === has2(r, "text")) refuse3(n);
  const { room, height, code, text } = r;
  if (!isStr3(room) || !commits.has(room) || typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) refuse3(n);
  if (has2(r, "code")) {
    if (!isStr3(code) || !CAPTION_CODE_RE.test(code) || !captionCodes.has(code)) refuse3(n);
    return { room, height, code, text: null };
  }
  if (!isStr3(text) || chars(text) < 1 || chars(text) > CAPTION_TEXT_MAX) refuse3(n);
  return { room, height, code: null, text };
}
function parse(buf, captionCodes) {
  const lines = splitLines(buf);
  if (lines.length === 0) refuse3(0);
  const head = record(lines[0], 1);
  if (head["t"] !== "header") refuse3(1);
  const rooms = parseHeader(head, 1);
  const commits = new Map(rooms.map((r) => [r.room, []]));
  const captions = [];
  for (let i = 1; i < lines.length; i++) {
    const n = i + 1;
    const r = record(lines[i], n);
    if (r["t"] === "commit") {
      const c = parseCommit(r, n, commits);
      commits.get(c.room).push(c);
    } else if (r["t"] === "caption") {
      captions.push({ c: parseCaption(r, n, commits, captionCodes), line: n });
    } else {
      refuse3(n);
    }
  }
  for (const { c, line } of captions) if (c.height >= commits.get(c.room).length) refuse3(line);
  return { rooms, commits, captions: captions.map((x) => x.c) };
}
function parseDemoLog(buf, captionCodes) {
  try {
    return parse(buf, captionCodes);
  } catch (e) {
    if (e instanceof Refusal) return { line: e.line };
    throw e;
  }
}
async function readDemoFile(path2, reader) {
  try {
    const r = await reader.read(path2, DEMO_MAX_BYTES);
    return Buffer.isBuffer(r) ? r : { line: 0 };
  } catch {
    return { line: 0 };
  }
}
function demoRoomId(salt, room) {
  return `r${base32c(createHash5("sha256").update(salt).update(Buffer.from(`demo:${room}`, "utf8")).digest()).slice(0, 8)}`;
}
var DemoRoomSource = class {
  kind = "demo";
  room;
  steps;
  protocol;
  constructor(room, commits) {
    this.room = room.room;
    commits.forEach((c, i) => {
      if (c.room !== room.room || c.height !== i) throw new RangeError(`DemoRoomSource: commit ${i} of room ${room.room} is ${c.room}:${c.height}`);
    });
    this.protocol = commits[0]?.protocol ?? null;
    if (commits.length > 0 && this.protocol === null) throw new RangeError(`DemoRoomSource: room ${room.room} has no height-0 protocol`);
    let liveCode = "";
    this.steps = commits.map((c) => {
      if (c.height === 0 || c.code.changed) liveCode = c.live ?? sha1(`${this.room}:${c.height}:live`);
      const { cs, paths: counts } = csOf(c.cs);
      const csPaths = /* @__PURE__ */ new Map();
      for (const [id, list] of c.csPaths) if (counts.get(id) === list.length) csPaths.set(id, [...list]);
      return {
        draft: toDraft({ liveCode, writer: c.writer === null ? null : parseWriter(c.writer), cs, protocol: this.protocol, opsLines: c.ops, checkpoint: null, heldIds: c.held }),
        oid: sha1(`${this.room}:${c.height}:board`),
        code: { changed: c.code.changed, shape: c.height === 0 ? "genesis" : c.code.base !== null ? "base_move" : "ordinary", seats: [...c.code.seats], base: c.code.base },
        csPaths
      };
    });
  }
  async tip() {
    const h = this.steps.length - 1;
    return h < 0 ? null : { height: h, key: `${this.room}:${h}` };
  }
  async changed() {
    return false;
  }
  /** A demo never moves: the tip itself is 'none', an earlier height of this room 'ff', anything else 'rewrite'. */
  async advance(last) {
    const t = await this.tip();
    if (t === null) return { kind: "gone" };
    if (last.key === t.key && last.height === t.height) return { kind: "none" };
    if (last.height >= 0 && last.height < t.height && last.key === `${this.room}:${last.height}`) return { kind: "ff", to: t };
    return { kind: "rewrite", to: t };
  }
  /** initialFoldState(protocol of height 0) at 0 (the state before B0); the fold state after height h for h > 0. */
  async startAt(h) {
    if (!Number.isSafeInteger(h) || h < 0 || h >= this.steps.length) throw new RangeError(`DemoRoomSource.startAt: no height ${h} in room ${this.room}`);
    let s = initialFoldState(this.protocol);
    if (h === 0) return s;
    for (let i = 0; i <= h; i++) s = foldCommit(s, this.steps[i].draft, ZERO_PEER).state;
    return s;
  }
  /** Frames of heights from…to (inclusive), folded from `start` (the state at from − 1). */
  async *frames(start, from, to, self) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to >= this.steps.length || from > to + 1) {
      throw new RangeError(`DemoRoomSource.frames: ${from}…${to} outside room ${this.room}'s heights 0…${this.steps.length - 1}`);
    }
    let prev = start;
    for (let h = from; h <= to; h++) {
      const s = this.steps[h];
      const f = foldFrame(prev, { height: h, oid: s.oid, draft: s.draft, csPaths: s.csPaths, code: s.code, malformed: false }, self);
      prev = f.after;
      yield f;
    }
  }
};
function csOf(values) {
  const { cs } = parseCsTrailers(values.map((value) => ({ key: "Cowork-CS", value })));
  return { cs, paths: new Map(cs.map((c) => [c.csId, c.paths])) };
}

// src/viz/source/git.ts
import { join as join2 } from "node:path";

// src/board/batchRead.ts
var READ_BATCH_MAX = 1280;
function isBoardReadFailure(r) {
  return "malformed" in r;
}
var WRITER_KEY = "Cowork-Writer";
var SEAT_KEY = "Cowork-Seat";
var BASE_KEY2 = "Cowork-Base";
var OPS_FILE = "ops.jsonl";
var PROTOCOL_FILE = "protocol.json";
var HELD_DIR = "held";
var CHECKPOINT_DIR = "checkpoint";
var STATE_FILE = "state.json";
var CHECKPOINT_STATE = `${CHECKPOINT_DIR}/${STATE_FILE}`;
var GIT_DIED = 128;
var ITEM_SUFFIXES = ["", "^{tree}", `:${OPS_FILE}`, `:${PROTOCOL_FILE}`, `:${HELD_DIR}`, `:${CHECKPOINT_DIR}`, `:${CHECKPOINT_DIR}/${STATE_FILE}`];
var TREE_READ_MAX_BYTES = 65536;
function parseCommitObject2(oid, body) {
  return parseCommitObject(oid, body.toString("utf8"));
}
function writerOf2(trailers) {
  const writers = valuesOf(trailers, WRITER_KEY);
  return writers.length === 1 ? parseWriter(writers[0]) : null;
}
function valuesOf(trailers, key) {
  return trailers.filter((t) => t.key === key).map((t) => t.value);
}
function parsedCommit(oid, body) {
  try {
    return parseCommitObject2(oid, body);
  } catch {
    return null;
  }
}
function heldIdsOf(raw, hashBytes) {
  if (raw === null) return [];
  try {
    return subtreeNames(raw, hashBytes);
  } catch {
    return [];
  }
}
function liveRead(oid, body) {
  const info = parsedCommit(oid, body);
  if (info === null) return { oid, malformed: "unreadable" };
  const bases = valuesOf(info.trailers, BASE_KEY2);
  const { cs, paths } = parseCsTrailers(info.trailers);
  const base = bases.length === 1 ? bases[0] : void 0;
  return { oid, info, writer: writerOf2(info.trailers), seats: valuesOf(info.trailers, SEAT_KEY), cs, csPaths: paths, base: isOid(base) ? base : null };
}
function commitRefusal(e) {
  if (e === null) return "missing";
  if (e.type !== "commit") return "not_commit";
  return e.size > BOARD_COMMIT_OBJECT_MAX_BYTES ? "commit_too_large" : null;
}
var ofType = (e, type) => e !== null && e !== void 0 && e.type === type ? e : null;
function treeEntries(raw, hashBytes) {
  if (raw === void 0) return null;
  const entries = [];
  let pos2 = 0;
  while (pos2 < raw.length) {
    const sp = raw.indexOf(32, pos2);
    const nul = sp < 0 ? -1 : raw.indexOf(0, sp + 1);
    if (nul < 0 || nul === sp + 1 || nul + 1 + hashBytes > raw.length) return null;
    const mode = raw.toString("latin1", pos2, sp);
    if (!/^[0-7]+$/.test(mode)) return null;
    entries.push({ mode, name: raw.subarray(sp + 1, nul) });
    pos2 = nul + 1 + hashBytes;
  }
  return entries;
}
function modeType(mode) {
  const fmt = Number.parseInt(mode.slice(-6), 8) & 61440;
  return fmt === 16384 ? "tree" : fmt === 32768 || fmt === 40960 ? "blob" : "commit";
}
function findEntry(entries, path2) {
  const want = Buffer.from(path2, "utf8");
  for (const e of entries) {
    const n = e.name.length;
    if (n > want.length) continue;
    const cmp = Buffer.compare(want.subarray(0, n), e.name);
    if (cmp > 0) continue;
    if (cmp < 0) return null;
    if (n === want.length) return e;
    if (want[n] !== 47) continue;
    return modeType(e.mode) === "tree" ? e : null;
  }
  return null;
}
function recordBytes(e) {
  return Buffer.byteLength(`${e.oid} ${e.type} ${e.size}
`, "utf8") + e.size + 1;
}
async function check(git, names) {
  for (const n of names) if (/[\n\r]/.test(n)) throw new Error(`cat-file --batch-check: invalid object name ${JSON.stringify(n)}`);
  const r = await git.run(["cat-file", "--batch-check"], { stdin: Buffer.from(`${names.join("\n")}
`, "utf8") });
  return batchCheck(r.stdout, names.length);
}
function budget(wants, spent) {
  const queued = /* @__PURE__ */ new Map();
  let bytes2 = 0;
  for (let i = 0; i < wants.length; i++) {
    const fresh = /* @__PURE__ */ new Map();
    for (const e of wants[i]) if (e !== null && !queued.has(e.oid)) fresh.set(e.oid, e);
    let cost = 0;
    for (const e of fresh.values()) cost += recordBytes(e);
    if ((i > 0 || spent > 0) && spent + bytes2 + cost > BATCH_READ_MAX_BYTES) return { queued, next: i, bytes: bytes2 };
    bytes2 += cost;
    for (const [oid, e] of fresh) queued.set(oid, e);
  }
  return { queued, next: wants.length, bytes: bytes2 };
}
async function read(git, queued) {
  const bodies = /* @__PURE__ */ new Map();
  if (queued.size === 0) return bodies;
  const list = [...queued.values()];
  const r = await git.run(["cat-file", "--batch"], { stdin: Buffer.from(`${list.map((e) => e.oid).join("\n")}
`, "utf8") });
  batchObjects(r.stdout, list.length).forEach((o, i) => {
    const e = list[i];
    if (o === null || o.type !== e.type || o.body.length !== e.size) throw new Error(`cat-file --batch disagrees with --batch-check on ${e.oid}`);
    bodies.set(e.oid, o.body);
  });
  return bodies;
}
function checkItems(n, what) {
  if (n > READ_BATCH_MAX) throw new RangeError(`${what}: ${n} items > ${READ_BATCH_MAX} in one batch`);
}
function gitDied(e) {
  return e instanceof GitCommandError && e.code === GIT_DIED;
}
async function roundOrItems(whole, count, one, unreadable) {
  try {
    const { reads: reads2, next } = await whole();
    return { reads: reads2, next };
  } catch (e) {
    if (!gitDied(e)) throw e;
  }
  const reads = [];
  let spent = 0;
  for (let i = 0; i < count; i++) {
    let r;
    try {
      r = await one(i, reads, spent);
    } catch (e) {
      if (!gitDied(e)) throw e;
      r = { reads: [unreadable(i)], next: 1, bytes: 0 };
    }
    if (r.next === 0) return { reads, next: i };
    spent += r.bytes;
    reads.push(r.reads[0]);
  }
  return { reads, next: count };
}
function lostObject(p, bodies) {
  if (p.root === null) return true;
  if (!p.unresolved) return false;
  const hashBytes = p.oid.length / 2;
  const top = treeEntries(bodies.get(p.root.oid), hashBytes);
  if (top === null) return false;
  const lost = (entries, name, type, rec) => {
    if (rec !== null) return false;
    const e2 = findEntry(entries, name);
    return e2 !== null && modeType(e2.mode) === type;
  };
  if (lost(top, OPS_FILE, "blob", p.raw.ops) || lost(top, PROTOCOL_FILE, "blob", p.raw.protocol) || lost(top, HELD_DIR, "tree", p.raw.held)) return true;
  if (p.raw.ckState !== null) return false;
  const e = findEntry(top, CHECKPOINT_STATE);
  if (e === null) return false;
  if (e.name.length === Buffer.byteLength(CHECKPOINT_STATE, "utf8")) return modeType(e.mode) === "blob";
  if (p.ckDir === null) return true;
  if (p.ckDir.type !== "tree") return false;
  const sub = treeEntries(bodies.get(p.ckDir.oid), hashBytes);
  return sub !== null && lost(sub, STATE_FILE, "blob", null);
}
async function readBoardCommits(git, items, opts = {}) {
  checkItems(items.length, "readBoardCommits");
  for (const { oid, height } of items) {
    if (!isOid(oid) || !Number.isSafeInteger(height) || height < 0) throw new TypeError(`readBoardCommits: invalid item ${JSON.stringify({ oid, height })}`);
  }
  if (items.length === 0) return { reads: [], next: 0 };
  const withLive = opts.withLive === true;
  const prevLive = opts.prevLive ?? null;
  return roundOrItems(
    () => boardRound(git, items, withLive, prevLive, 0),
    items.length,
    // The preceding item's live commit, as the caller of a next round passes it (null after a failure).
    (i, done, spent) => boardRound(git, [items[i]], withLive, i === 0 ? prevLive : liveCodeOf(done[i - 1]), spent),
    (i) => ({ oid: items[i].oid, height: items[i].height, malformed: "unreadable" })
  );
}
function liveCodeOf(r) {
  return isBoardReadFailure(r) ? null : r.liveCode;
}
async function boardRound(git, items, withLive, prevLive, spent) {
  const per = ITEM_SUFFIXES.length + (withLive ? 1 : 0);
  const names = [];
  for (const { oid, height } of items) {
    for (const s of ITEM_SUFFIXES) names.push(`${oid}${s}`);
    if (withLive) names.push(`${oid}^${height === 0 ? 1 : 2}`);
  }
  const recs = await check(git, names);
  const plans = items.map(({ oid, height }, i) => {
    const [commit = null, root = null, ops = null, protocol = null, held = null, ckDir = null, ckState = null, live = null] = recs.slice(per * i, per * i + per);
    const refused = commitRefusal(commit);
    const entries = { root: ofType(root, "tree"), ops: ofType(ops, "blob"), protocol: ofType(protocol, "blob"), held: ofType(held, "tree"), checkpoint: ofType(ckState, "blob") };
    const over = refused === null ? capViolation(entries) : null;
    const unresolved = [root, ops, protocol, held, ckDir, ckState].some((r) => r === null);
    return { oid, height, commit, refused, root, ckDir, raw: { ops, protocol, held, ckState }, entries, over, unresolved, live: withLive ? live : null };
  });
  const laterLives = /* @__PURE__ */ new Set();
  plans.forEach((p, i) => {
    if (i > 0 && p.refused === null && p.over === null && p.live !== null) laterLives.add(p.live.oid);
  });
  const smallTree = (e) => e !== null && e.type === "tree" && e.size <= TREE_READ_MAX_BYTES ? e : null;
  const { queued, next, bytes: bytes2 } = budget(plans.map((p, i) => {
    if (p.refused !== null) return [];
    if (p.over !== null) return p.over.reason === "entry_missing" && p.unresolved ? [p.commit, smallTree(p.root), p.raw.ckState === null ? smallTree(p.ckDir) : null] : [p.commit];
    const want = [p.commit, p.entries.ops, p.entries.protocol, p.entries.held];
    if (p.height % CHECKPOINT_EVERY === 0) want.push(p.entries.checkpoint);
    if (p.unresolved) want.push(smallTree(p.root), p.raw.ckState === null ? smallTree(p.ckDir) : null);
    if (p.live !== null && commitRefusal(p.live) === null && !(i === 0 && p.live.oid === prevLive && !laterLives.has(p.live.oid))) want.push(p.live);
    return want;
  }), spent);
  const bodies = await read(git, queued);
  const body = (e) => e === null ? null : bodies.get(e.oid) ?? null;
  const out = [];
  for (const p of plans.slice(0, next)) {
    const { oid, height } = p;
    let res;
    const info = p.refused === null ? parsedCommit(oid, body(p.commit)) : null;
    const last = info === null ? void 0 : info.parents[info.parents.length - 1];
    if (p.refused !== null) res = { oid, height, malformed: p.refused };
    else if (info === null) res = { oid, height, malformed: "unreadable" };
    else if (last === void 0) res = { oid, height, malformed: "no_parent" };
    else if (p.over !== null && p.over.reason !== "entry_missing") res = { oid, height, malformed: p.over.reason };
    else if (lostObject(p, bodies)) res = { oid, height, malformed: "missing" };
    else if (p.over !== null) res = { oid, height, malformed: p.over.reason };
    else {
      const { cs, paths } = parseCsTrailers(info.trailers);
      const checkpoint = height % CHECKPOINT_EVERY === 0 ? body(p.entries.checkpoint) : null;
      const prev = out.length === 0 ? prevLive : liveCodeOf(out[out.length - 1]);
      res = {
        oid,
        parents: [...info.parents],
        firstParent: info.parents.length >= 2 ? info.parents[0] : null,
        liveCode: last,
        writer: writerOf2(info.trailers),
        cs,
        protocol: readProtocol(body(p.entries.protocol)),
        opsLines: opsLinesOf(body(p.entries.ops)),
        checkpoint: checkpoint === null ? null : Buffer.from(checkpoint),
        heldIds: heldIdsOf(body(p.entries.held), oid.length / 2),
        height,
        info,
        csPaths: paths,
        live: withLive ? liveOf(p.live, info, height, last, prev, bodies) : null
      };
    }
    out.push(res);
  }
  return { reads: out, next, bytes: bytes2 };
}
function liveOf(rec, info, height, last, prev, bodies) {
  if (info.parents.length !== (height === 0 ? 1 : 2)) return { oid: last, malformed: "not_commit" };
  if (rec === null) return { oid: last, malformed: "missing" };
  if (rec.oid === prev) return "same";
  const refused = commitRefusal(rec);
  if (refused !== null) return { oid: rec.oid, malformed: refused };
  const b = bodies.get(rec.oid);
  if (b === void 0) throw new Error(`readBoardCommits: live commit ${rec.oid} was not read`);
  return liveRead(rec.oid, b);
}

// src/viz/source/git.ts
var REVPARSE_SAFETY_MS = 6e4;
var FF_PAGE = READ_BATCH_MAX + 1;
var FOLD_CACHE_MAX = 16;
var SEED_CHUNK = CHECKPOINT_EVERY;
var NO_LIVE = "0".repeat(40);
var BoardObjectMissingError = class extends Error {
  height;
  oid;
  constructor(height, oid) {
    super(`a board or live object of height ${height} is missing`);
    this.name = "BoardObjectMissingError";
    this.height = height;
    this.oid = oid;
  }
};
var samePair = (a, b) => a === null || b === null ? a === b : a.size === b.size && a.mtimeNs === b.mtimeNs;
var samePairs = (a, b) => a.length === b.length && a.every((x, i) => samePair(x, b[i]));
function stepOf(r, prev) {
  if (isBoardReadFailure(r)) {
    if (r.malformed === "missing") throw new BoardObjectMissingError(r.height, r.oid);
    const p = prev ?? { liveCode: NO_LIVE, protocol: readProtocol(null), seats: [], base: null };
    return {
      input: { height: r.height, oid: r.oid, draft: noopDraft(p), csPaths: /* @__PURE__ */ new Map(), code: { changed: false, shape: null, seats: [], base: null }, malformed: true },
      seed: p
    };
  }
  const live = r.live;
  const changed = prev === null || r.liveCode !== prev.liveCode;
  let code;
  if (live === "same" || live === null) {
    code = { changed: false, shape: null, seats: prev === null ? [] : [...prev.seats], base: prev?.base ?? null };
  } else if ("malformed" in live) {
    if (live.malformed === "missing") throw new BoardObjectMissingError(r.height, live.oid ?? r.liveCode);
    code = { changed, shape: null, seats: [], base: null };
  } else {
    const shape = r.height === 0 ? liveShape(live.info, null) : changed && prev !== null ? liveShape(live.info, prev.liveCode) : null;
    code = { changed, shape, seats: [...live.seats], base: live.base };
  }
  const draft = toDraft({ liveCode: r.liveCode, writer: r.writer, cs: r.cs, protocol: r.protocol, opsLines: r.opsLines, checkpoint: r.checkpoint, heldIds: r.heldIds });
  return {
    input: { height: r.height, oid: r.oid, draft, csPaths: r.csPaths, code, malformed: false },
    seed: { liveCode: r.liveCode, protocol: r.protocol, seats: code.seats, base: code.base }
  };
}
var GitRoomSource = class {
  kind = "git";
  git;
  fs;
  clock;
  ref;
  refFile;
  packedRefs;
  reftable;
  pinned = null;
  oids = /* @__PURE__ */ new Map();
  /** The stat pairs taken just before the rev-parse of the last tip() or advance() that succeeded; null before one, after a failed one or when the stat failed. */
  baseline = null;
  /** Δmono anchor of the safety net: the rev-parse of the last successful tip() or advance(), or the last time the net fired. */
  resolvedAt = null;
  /** The seed after the last height folded or read on the pinned chain. */
  seed = null;
  /**
   * startAt's folded states at checkpoint heights whose checkpoint does not parse, by height, each with the board oid at that
   * height (the state is a function of that commit's first-parent chain, so an entry is served only while the pinned chain
   * holds the same oid there — across ff, rewrites above it and re-pins alike); insertion order = recency, ≤ FOLD_CACHE_MAX.
   */
  folds = /* @__PURE__ */ new Map();
  constructor(spec, git, deps) {
    if (spec.kind !== "git" || spec.gitDir === null || spec.boardRef === null) throw new Error("GitRoomSource: a git room needs a gitDir and a board ref");
    this.git = git;
    this.fs = deps.fs;
    this.clock = deps.clock;
    this.ref = spec.boardRef;
    this.refFile = join2(spec.gitDir, ...spec.boardRef.split("/"));
    this.packedRefs = join2(spec.gitDir, "packed-refs");
    this.reftable = join2(spec.gitDir, "reftable");
  }
  /** (size, mtime) of <gitdir>/refs/cowork-remote/<e>/board, <gitdir>/packed-refs and, when <gitdir>/reftable/ exists, reftable/tables.list. */
  async statPairs() {
    const pair = async (p) => {
      const l = await this.fs.lstat(p);
      return l === null ? null : { size: l.size, mtimeNs: l.mtimeNs };
    };
    const out = [await pair(this.refFile), await pair(this.packedRefs)];
    const rt = await this.fs.lstat(this.reftable);
    if (rt !== null && rt.isDirectory) out.push(await pair(join2(this.reftable, "tables.list")));
    return out;
  }
  /** A stat pair differs from the pairs taken before the last rev-parse (a stat error counts as a change), or 60 s passed since that rev-parse or since the net last fired. No git process. */
  async changed() {
    let pairs;
    try {
      pairs = await this.statPairs();
    } catch {
      return true;
    }
    if (this.baseline === null || !samePairs(pairs, this.baseline)) return true;
    const now = this.clock.monoMs();
    if (this.resolvedAt === null || now - this.resolvedAt >= REVPARSE_SAFETY_MS) {
      this.resolvedAt = now;
      return true;
    }
    return false;
  }
  /** rev-parse of the board ref (the stat pairs taken first, so an update between the two is seen next tick) and the pin; then its height by rev-list --count when it is new. */
  async tip() {
    return this.resolving(async (oid) => {
      if (oid === null) return this.pin(null, false);
      if (this.pinned !== null && this.pinned.oid === oid) return { height: this.pinned.height, key: oid };
      return this.pin({ oid, height: await this.git.chainCount(oid) - 2 }, false);
    });
  }
  /**
   * R-V31: re-resolve; the ref gone → 'gone'; the same oid → 'none'; else the new tip's newest 1,281 commits: the last folded
   * oid at index n → 'ff' to last.height + n; not on a full page → rev-list --count and the one commit at last.height
   * (--skip) tell a catch-up beyond 1,280 ('ff') from a rewrite; not on a shorter page (the whole chain) → 'rewrite'.
   */
  async advance(last) {
    return this.resolving(async (oid) => {
      if (oid === null) {
        this.pin(null, false);
        return { kind: "gone" };
      }
      if (oid === last.key) {
        this.pin({ oid, height: last.height }, this.pinned?.oid === oid);
        return { kind: "none" };
      }
      const page = await this.git.chain(oid, 0, FF_PAGE);
      const n = page.indexOf(last.key);
      let height;
      let kind = "rewrite";
      if (n > 0) {
        height = last.height + n;
        kind = "ff";
      } else if (page.length < FF_PAGE) {
        height = page.length - 2;
      } else {
        height = await this.git.chainCount(oid) - 2;
        if (height > last.height && (await this.git.chain(oid, height - last.height, 1))[0] === last.key) kind = "ff";
      }
      if (height < 0) {
        this.pin(null, false);
        return { kind: "gone" };
      }
      const to = this.pin({ oid, height }, kind === "ff" && this.pinned?.oid === last.key);
      page.forEach((o, i) => {
        if (height - i >= 0) this.oids.set(height - i, o);
      });
      return { kind, to };
    });
  }
  /**
   * initialFoldState(protocol of B0) at 0; for h % 256 === 0, parseFold(checkpoint/state.json at h) when it parses at its
   * own height (trusted as a joiner trusts it, glossary §24 default 9), else the state below (this rule, one checkpoint
   * down) folded up to h — that state is cached for h and its board oid (FOLD_CACHE_MAX), and a cached state is served
   * (a copy) before anything is read, so a run of unparseable checkpoints is folded up once, from the last good state. The
   * board commit at h is read with its live commit, which seeds frames from h + 1 (after a cached state, frames reads it).
   */
  async startAt(h) {
    const pin = this.requirePin();
    if (!Number.isSafeInteger(h) || h < 0 || h > pin.height || h % CHECKPOINT_EVERY !== 0) throw new RangeError(`GitRoomSource.startAt: ${h} is not a checkpoint height of the pinned tip (0…${pin.height})`);
    if (h > 0) {
      await this.list(h, h);
      const hit = this.folds.get(h);
      if (hit !== void 0 && hit.oid === this.oids.get(h)) {
        this.folds.delete(h);
        this.folds.set(h, hit);
        return structuredClone(hit.state);
      }
    }
    const [{ read: read2 }] = await this.readSteps([h], null);
    const oid = this.oids.get(h);
    if (isBoardReadFailure(read2)) {
      if (read2.malformed === "missing") throw new BoardObjectMissingError(h, read2.oid);
    } else {
      this.seed = { height: h, oid, seed: stepOf(read2, null).seed };
    }
    if (h === 0) return initialFoldState(isBoardReadFailure(read2) ? readProtocol(null) : read2.protocol);
    const s = isBoardReadFailure(read2) || read2.checkpoint === null ? null : parseFold(read2.checkpoint);
    if (s !== null && s.height === h) return s;
    const below = await this.startAt(h - CHECKPOINT_EVERY);
    let state = below;
    for await (const f of this.frames(below, h === CHECKPOINT_EVERY ? 0 : h - CHECKPOINT_EVERY + 1, h, ZERO_PEER)) state = f.after;
    this.folds.delete(h);
    this.folds.set(h, { oid, state: structuredClone(state) });
    for (const k of this.folds.keys()) {
      if (this.folds.size <= FOLD_CACHE_MAX) break;
      this.folds.delete(k);
    }
    return state;
  }
  /** Frames of heights from…to of the pinned tip, folded from `start` (the state at from − 1): one listing, reads in batches of ≤ 1,280. */
  async *frames(start, from, to, self) {
    const pin = this.requirePin();
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > pin.height || from > to + 1) {
      throw new RangeError(`GitRoomSource.frames: ${from}…${to} outside the pinned tip's heights 0…${pin.height}`);
    }
    if (from > to) return;
    if (start.height !== from - 1) throw new RangeError(`GitRoomSource.frames: a start state at height ${start.height} does not precede height ${from}`);
    await this.list(Math.max(0, from - 1), to);
    let seed = from === 0 ? null : await this.seedAt(from - 1);
    let prev = start;
    for (let b = from; b <= to; b += READ_BATCH_MAX) {
      const e = Math.min(to, b + READ_BATCH_MAX - 1);
      const steps = [];
      for (const { read: read2 } of await this.readSteps(range(b, e), seed?.liveCode ?? null)) {
        const s = stepOf(read2, seed);
        steps.push(s);
        seed = s.seed;
      }
      this.seed = { height: e, oid: this.oids.get(e), seed };
      for (const s of steps) {
        const f = foldFrame(prev, s.input, self);
        prev = f.after;
        yield f;
      }
    }
  }
  // ---- internals --------------------------------------------------------------------------------------------
  requirePin() {
    if (this.pinned === null) throw new Error("GitRoomSource: no pinned tip (call tip() or advance() first)");
    return this.pinned;
  }
  /**
   * The stat pairs (taken first, so an update between them and the rev-parse is seen next tick), rev-parse --verify -q of
   * the board ref, then `op` with its oid. The pairs become changed()'s baseline, and the rev-parse resets the safety net,
   * only when the whole operation succeeds; a failure at or after the rev-parse (a transient git error, the watchdog kill,
   * a ref naming a non-commit) leaves no baseline, so the next changed() is true and the store retries next tick instead of
   * waiting for the 60 s net (the pin is unchanged: every pin() call follows the last git call that can fail).
   */
  async resolving(op) {
    let pairs;
    try {
      pairs = await this.statPairs();
    } catch {
      pairs = null;
    }
    try {
      const oid = await this.git.revParse(this.ref);
      const at = this.clock.monoMs();
      const out = await op(oid);
      this.baseline = pairs;
      this.resolvedAt = at;
      return out;
    } catch (e) {
      this.baseline = null;
      throw e;
    }
  }
  /** Pins p (null: none). keep: p extends the old pin's chain, so its oids by height stay valid; otherwise they are dropped. */
  pin(p, keep) {
    if (p !== null && p.height < 0) p = null;
    if (!keep) {
      this.oids = /* @__PURE__ */ new Map();
      this.seed = null;
    }
    this.pinned = p;
    if (p === null) return null;
    this.oids.set(p.height, p.oid);
    return { height: p.height, key: p.oid };
  }
  /** The oids of heights lo…hi of the pinned chain: those not yet known in one rev-list. */
  async list(lo, hi) {
    const pin = this.requirePin();
    let top = hi;
    while (top >= lo && this.oids.has(top)) top--;
    let bottom = lo;
    while (bottom <= top && this.oids.has(bottom)) bottom++;
    if (top < bottom) return;
    const got = await this.git.chain(pin.oid, pin.height - top, top - bottom + 1);
    if (got.length !== top - bottom + 1) throw new Error(`GitRoomSource: the first-parent chain of the pinned tip is shorter than its count`);
    got.forEach((o, i) => this.oids.set(top - i, o));
  }
  /**
   * Reads the board commits at `heights` (≤ READ_BATCH_MAX, ascending, oids known) with their live commits, call after call
   * from `next` (R-V69), prevLive carried across calls as the last draft's liveCode (a no-op draft keeps the previous one).
   */
  async readSteps(heights, prevLive) {
    await this.list(heights[0], heights[heights.length - 1]);
    const items = heights.map((h) => ({ oid: this.oids.get(h), height: h }));
    const out = [];
    let live = prevLive;
    while (out.length < items.length) {
      const { reads, next } = await readBoardCommits(this.git, items.slice(out.length), { withLive: true, prevLive: live });
      if (next === 0) throw new Error("GitRoomSource: a batched read made no progress");
      for (const read2 of reads) {
        out.push({ read: read2 });
        if (!isBoardReadFailure(read2)) live = read2.liveCode;
      }
    }
    return out;
  }
  /**
   * The seed of height h: the last frame's when it is h of this chain; else h read with its live commit — and when h is a
   * malformed board commit (a no-op draft carries the previous draft), the readable draft below it, read downward in chunks
   * of 256 (genesis-less chains end at a fixed placeholder). A missing object on the way throws.
   */
  async seedAt(h) {
    const known = this.seed;
    if (known !== null && known.height === h && known.oid === this.oids.get(h)) return known.seed;
    let window = [h];
    let found = null;
    for (; ; ) {
      const reads = await this.readSteps(window, null);
      const firstOk = reads.findIndex((x) => !isBoardReadFailure(x.read));
      if (firstOk >= 0) {
        for (const { read: read2 } of reads.slice(firstOk)) found = stepOf(read2, found).seed;
        break;
      }
      for (const { read: read2 } of reads) stepOf(read2, null);
      if (window[0] === 0) break;
      const hi = window[0] - 1;
      window = range(Math.max(0, hi - SEED_CHUNK + 1), hi);
    }
    const seed = found ?? { liveCode: NO_LIVE, protocol: readProtocol(null), seats: [], base: null };
    this.seed = { height: h, oid: this.oids.get(h), seed };
    return seed;
  }
};
function range(lo, hi) {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// src/viz/source/rooms.ts
import { createHash as createHash6 } from "node:crypto";
import { posix as posix3, win32 as win324 } from "node:path";

// src/data/canonRoot.ts
import { posix as posix2, win32 as win323 } from "node:path";
function stripTrailing(p, path2) {
  const root = path2.parse(p).root;
  let s = p;
  while (s.length > root.length && (s.endsWith("/") || path2 === win323 && s.endsWith("\\"))) s = s.slice(0, -1);
  return s;
}
function canonRoot(p, probe, platform) {
  const path2 = platform === "win32" ? win323 : posix2;
  let cur = stripTrailing(platform === "win32" ? p.replace(/\//g, "\\") : p, path2);
  const rest = [];
  while (!probe.exists(cur)) {
    const parent = path2.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path2.basename(cur));
    cur = parent;
  }
  const base = probe.exists(cur) ? probe.realpathNative(cur) : cur;
  let out = rest.length === 0 ? base : path2.join(base, ...rest);
  if (platform === "win32") out = out.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => `${d.toLowerCase()}:`);
  return out.normalize("NFC");
}

// src/git/enc.ts
import { Buffer as Buffer2 } from "node:buffer";
var ENC_MAX_BYTES = 150;
var EncTooLongError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "EncTooLongError";
  }
};
var LONE_SURROGATE3 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function isUnreservedByte(b) {
  return b >= 48 && b <= 57 || // 0-9
  b >= 65 && b <= 90 || // A-Z
  b >= 97 && b <= 122 || // a-z
  b === 95 || // _
  b === 45;
}
function enc(branch) {
  if (branch.length === 0) {
    throw new Error("enc: the branch name is empty");
  }
  if (LONE_SURROGATE3.test(branch)) {
    throw new Error("enc: the branch name contains a lone UTF-16 surrogate");
  }
  let out = "";
  for (const b of Buffer2.from(branch, "utf8")) {
    out += isUnreservedByte(b) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0");
    if (out.length > ENC_MAX_BYTES) {
      throw new EncTooLongError(`enc: the encoded branch name exceeds ${ENC_MAX_BYTES} bytes`);
    }
  }
  return out;
}

// src/viz/source/rooms.ts
var ROOMS_MAX2 = 32;
var BOARD_REF = /^refs\/cowork-remote\/([^/]+)\/board$/;
var ENC_FORM = /^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})+$/;
function roomId(salt, canonical) {
  const d = createHash6("sha256").update(salt).update(Buffer.from(canonical, "utf8")).digest();
  return `r${base32c(d).slice(0, 8)}`;
}
function decodeEnc(e) {
  if (typeof e !== "string" || !ENC_FORM.test(e)) return null;
  const bytes2 = [];
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "%") {
      bytes2.push(parseInt(e.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes2.push(e.charCodeAt(i));
    }
  }
  const b = Buffer.from(bytes2).toString("utf8");
  try {
    return enc(b) === e ? b : null;
  } catch {
    return null;
  }
}
var byUnits = (a, b) => a < b ? -1 : a > b ? 1 : 0;
async function admit(path2, deps) {
  const p = deps.platform === "win32" ? win324 : posix3;
  const dotGit = p.join(path2, ".git");
  const l = await deps.fs.lstat(dotGit);
  if (l === null || !l.isDirectory || l.isSymbolicLink) return null;
  const gitDir = await deps.fs.realpath(dotGit);
  const boards = [];
  for (const { ref } of await deps.git(gitDir).remoteRefs()) {
    const m = BOARD_REF.exec(ref);
    const branch = m === null ? null : decodeEnc(m[1]);
    if (branch !== null) boards.push({ ref, branch });
  }
  let pick;
  if (boards.length === 1) {
    pick = boards[0];
  } else if (boards.length > 1) {
    const s = await readStatus(gitDir, null, { fs: deps.fs, reader: deps.reader });
    const want = s.unreadable ? void 0 : s.fields?.branch;
    const matching = boards.filter((b) => b.branch === want);
    if (matching.length === 1) pick = matching[0];
  }
  if (pick === void 0) return null;
  const canonical = canonRoot(path2, deps.probe, deps.platform);
  return {
    canonical,
    spec: { id: roomId(deps.salt, canonical), kind: "git", label: posix3.basename(canonical), branch: pick.branch, gitDir, boardRef: pick.ref, canonicalRoot: canonical }
  };
}
async function discoverRooms(repos, deps) {
  if (repos.length === 0) return { refuse: "RF_VIZ_NO_ROOMS" };
  const byRoot = /* @__PURE__ */ new Map();
  for (const path2 of repos) {
    const f = await admit(path2, deps);
    if (f === null) return { refuse: "RF_VIZ_REPO_NOT_LIVE" };
    if (!byRoot.has(f.canonical)) byRoot.set(f.canonical, f);
  }
  const all = [...byRoot.values()].sort((a, b) => byUnits(a.spec.label, b.spec.label) || byUnits(a.canonical, b.canonical));
  return { rooms: all.slice(0, ROOMS_MAX2).map((f) => f.spec), more: Math.max(0, all.length - ROOMS_MAX2) };
}

// src/viz/source/vizGit.ts
import { isAbsolute as isAbsolute2, join as join3 } from "node:path";

// src/git/runner.ts
import { spawn as spawn2, spawnSync } from "node:child_process";
import { win32 as win326 } from "node:path";

// src/git/flags.ts
import { isAbsolute, posix as posix4, win32 as win325 } from "node:path";

// src/git/env.ts
var FORCED_ENV = Object.freeze({
  LC_ALL: "C",
  LANGUAGE: "",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_OPTIONAL_LOCKS: "0"
});
var BASE_ALLOW_NAMES = ["PATH", "SYSTEMROOT", "COMSPEC", "USERPROFILE", "HOME", "TEMP", "TMP", "TMPDIR", "LANG"];
var BASE_ALLOW_PREFIXES = ["LC_"];
var TRANSPORT_ALLOW_NAMES = [
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATHEXT",
  "WINDIR",
  "SYSTEMDRIVE",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_SSH_VARIANT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM"
];
var TRANSPORT_ALLOW_PREFIXES = ["XDG_", "GCM_"];
var NEVER_NAMES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_EDITOR",
  "GIT_ATTR_SOURCE",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_SHALLOW_FILE",
  "GIT_CONFIG",
  // Ruling P2-GRAFTS: buildGitInvocation sets its own GIT_GRAFT_FILE (a path that never exists).
  "GIT_GRAFT_FILE"
];
var NEVER_PREFIXES = [
  "CLAUDE_",
  "ELECTRON_",
  "VSCODE_",
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
  "GIT_TRACE",
  "GIT_AUTHOR_",
  "GIT_COMMITTER_"
];
var ALLOW_NAMES = /* @__PURE__ */ new Set([...BASE_ALLOW_NAMES, ...TRANSPORT_ALLOW_NAMES]);
var ALLOW_PREFIXES = [...BASE_ALLOW_PREFIXES, ...TRANSPORT_ALLOW_PREFIXES];
var NEVER = new Set(NEVER_NAMES);
var FORCED_UPPER = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));
function isNever(upper) {
  return NEVER.has(upper) || NEVER_PREFIXES.some((p) => upper.startsWith(p));
}
function isNeverName(name) {
  return isNever(name.toUpperCase());
}

// src/git/flags.ts
var GLOBAL_PREFIX = Object.freeze(["--no-replace-objects"]);
function noGraftsFile(hooksPath) {
  return `${hooksPath}/.no-grafts`;
}
var MERGE_FLAGS = Object.freeze([
  "-c",
  "merge.renormalize=false",
  "-c",
  "merge.renames=true",
  "-c",
  "merge.directoryRenames=false"
]);
var DIFF_FAMILY = /* @__PURE__ */ new Set(["diff", "diff-tree", "diff-index", "diff-files", "log", "show", "blame"]);
var CLASSES = /* @__PURE__ */ new Set(["local", "network", "attr", "refupdate"]);
var MERGE_COMMANDS = /* @__PURE__ */ new Set(["merge-tree", "merge-file"]);
var DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];
var FETCH_FLAGS = ["--no-write-fetch-head", "--no-auto-maintenance", "--no-tags", "--no-recurse-submodules"];
var SSH_BATCH_OPTIONS = "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3";
var PLINK_BATCH_OPTION = "-batch";
var OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var FORCED_UPPER2 = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));
function fail(message) {
  throw new Error(`buildGitInvocation: ${message}`);
}
function checkConfigValue(what, value) {
  if (value.length === 0 || /[\0\r\n]/.test(value)) fail(`invalid ${what} ${JSON.stringify(value)}`);
}
var FORCED_KEYS = /* @__PURE__ */ new Set([
  "core.hookspath",
  "core.fsmonitor",
  "core.quotepath",
  "core.safecrlf",
  "core.splitindex",
  "commit.gpgsign",
  "tag.gpgsign",
  "gc.auto",
  "maintenance.auto",
  "fetch.fsckobjects",
  "transfer.fsckobjects",
  "protocol.ext.allow",
  "core.askpass",
  "submodule.recurse",
  "core.longpaths",
  "attr.tree",
  "core.logallrefupdates",
  "core.fsync",
  "core.fsyncmethod",
  "http.lowspeedlimit",
  "http.lowspeedtime",
  "i18n.commitencoding",
  "i18n.logoutputencoding",
  "push.pushoption",
  "push.gpgsign",
  "push.followtags",
  "push.recursesubmodules",
  ...MERGE_FLAGS.filter((_, i) => i % 2 === 1).map((kv) => kv.slice(0, kv.indexOf("=")).toLowerCase())
]);
function isForcedKey(key) {
  const k = key.toLowerCase();
  return FORCED_KEYS.has(k) || k.startsWith("filter.") && k.endsWith(".required");
}
function checkAbsolute(what, value) {
  checkConfigValue(what, value);
  if (!isAbsolute(value)) fail(`${what} must be absolute, got ${JSON.stringify(value)}`);
}
function checkDriverName(d) {
  if (d.length === 0 || /[=\s\0]/.test(d)) fail(`invalid filter driver name ${JSON.stringify(d)}`);
}
function checkIdentField(what, value) {
  if (value.trim().length === 0 || /[\0\r\n<>]/.test(value)) fail(`invalid identity ${what} ${JSON.stringify(value)}`);
}
function setEnv(env, name, value) {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value;
}
function dropBlank(env, name) {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper && (env[k] ?? "").trim() === "") delete env[k];
  }
}
function getEnv(env, name) {
  const exact = env[name];
  if (exact !== void 0) return exact;
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k];
  }
  return void 0;
}
function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function firstWord(cmd) {
  let i = 0;
  while (i < cmd.length && /\s/.test(cmd.charAt(i))) i++;
  let word = "";
  let quote = "";
  for (; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) break;
    word += ch;
  }
  return word;
}
function programBase(program) {
  const parts = program.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase().replace(/\.exe$/, "");
}
function sshVariant(setting, program) {
  const v = (setting ?? "").trim().toLowerCase();
  if (v === "ssh") return "ssh";
  if (v === "plink" || v === "putty" || v === "tortoiseplink") return "plink";
  if (v === "simple") return "simple";
  const b = programBase(program);
  if (b === "ssh") return "ssh";
  if (b === "plink" || b === "tortoiseplink") return "plink";
  return "unknown";
}
function isSet(v) {
  return v !== void 0 && v.trim() !== "";
}
function batchSshCommand(env, configCommand) {
  const command = getEnv(env, "GIT_SSH_COMMAND");
  const program = getEnv(env, "GIT_SSH");
  let line;
  let prog;
  if (isSet(command)) {
    line = command.replace(/\s+$/, "");
    prog = firstWord(command);
  } else if (isSet(configCommand)) {
    line = configCommand.replace(/\s+$/, "");
    prog = firstWord(configCommand);
  } else if (isSet(program)) {
    line = shQuote(program);
    prog = program;
  } else {
    line = "ssh";
    prog = "ssh";
  }
  const variant = sshVariant(getEnv(env, "GIT_SSH_VARIANT"), prog);
  if (variant === "ssh") return `${line} ${SSH_BATCH_OPTIONS}`;
  if (variant === "plink") return `${line} ${PLINK_BATCH_OPTION}`;
  return null;
}
function buildEnv(opts, base) {
  const env = {};
  for (const [name, value] of Object.entries(base.daemonEnv)) {
    if (!isNeverName(name)) env[name] = value;
  }
  if (opts.extraEnv !== void 0) {
    for (const name of Object.keys(opts.extraEnv).sort()) {
      const value = opts.extraEnv[name];
      if (value === void 0 || FORCED_UPPER2.has(name.toUpperCase()) || isNeverName(name)) continue;
      setEnv(env, name, value);
    }
  }
  if (opts.indexFile !== void 0) {
    checkAbsolute("indexFile", opts.indexFile);
    setEnv(env, "GIT_INDEX_FILE", opts.indexFile);
  }
  if (opts.literalPathspecs === true) setEnv(env, "GIT_LITERAL_PATHSPECS", "1");
  setEnv(env, "GIT_GRAFT_FILE", noGraftsFile(base.hooksPath));
  if (opts.identity !== void 0) {
    checkIdentField("name", opts.identity.name);
    checkIdentField("email", opts.identity.email);
    setEnv(env, "GIT_AUTHOR_NAME", opts.identity.name);
    setEnv(env, "GIT_AUTHOR_EMAIL", opts.identity.email);
    setEnv(env, "GIT_COMMITTER_NAME", opts.identity.name);
    setEnv(env, "GIT_COMMITTER_EMAIL", opts.identity.email);
    setEnv(env, "TZ", "UTC0");
  }
  if (base.testBuild && opts.wallMsForDates !== void 0) {
    const ms = opts.wallMsForDates;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`buildGitInvocation: invalid wallMsForDates ${String(ms)}`);
    }
    const date = `@${Math.floor(ms / 1e3)} +0000`;
    setEnv(env, "GIT_AUTHOR_DATE", date);
    setEnv(env, "GIT_COMMITTER_DATE", date);
  }
  if (opts.class === "network") {
    dropBlank(env, "GIT_SSH_COMMAND");
    dropBlank(env, "GIT_SSH");
    const ssh = batchSshCommand(env, base.sshCommand);
    if (ssh !== null) setEnv(env, "GIT_SSH_COMMAND", ssh);
  }
  for (const [name, value] of Object.entries(FORCED_ENV)) setEnv(env, name, value);
  const sorted = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== void 0) sorted[k] = v;
  }
  return sorted;
}
function buildGitInvocation(args, opts, base) {
  const sub = args[0];
  if (sub === void 0 || sub.length === 0 || sub.startsWith("-")) {
    fail(`args[0] must be a git subcommand, got ${JSON.stringify(sub)}`);
  }
  if (!CLASSES.has(opts.class)) fail(`unknown class ${JSON.stringify(opts.class)}`);
  checkConfigValue("hooksPath", base.hooksPath);
  if (!(base.platform === "win32" ? win325 : posix4).isAbsolute(base.hooksPath)) fail(`hooksPath must be absolute, got ${JSON.stringify(base.hooksPath)}`);
  if (base.sshCommand !== void 0 && /[\0\r\n]/.test(base.sshCommand)) {
    fail(`invalid sshCommand ${JSON.stringify(base.sshCommand)}`);
  }
  if (opts.gitDir !== void 0) checkAbsolute("gitDir", opts.gitDir);
  if (opts.workTree !== void 0) checkAbsolute("workTree", opts.workTree);
  const pre = [...GLOBAL_PREFIX];
  if (opts.gitDir !== void 0) pre.push(`--git-dir=${opts.gitDir}`);
  if (opts.workTree !== void 0) pre.push(`--work-tree=${opts.workTree}`);
  const c = (kv) => {
    pre.push("-c", kv);
  };
  c(`core.hooksPath=${base.hooksPath}`);
  c(`core.fsmonitor=${opts.fsmonitor === true ? "true" : "false"}`);
  c("core.quotepath=off");
  c("core.safecrlf=false");
  c("core.splitIndex=false");
  c("commit.gpgSign=false");
  c("tag.gpgSign=false");
  c("gc.auto=0");
  c("maintenance.auto=false");
  c("fetch.fsckObjects=true");
  c("transfer.fsckObjects=true");
  c("protocol.ext.allow=never");
  c("core.askPass=");
  c("submodule.recurse=false");
  c("i18n.commitEncoding=UTF-8");
  c("i18n.logOutputEncoding=UTF-8");
  if (base.platform === "win32") c("core.longpaths=true");
  const drivers = /* @__PURE__ */ new Set(["lfs"]);
  for (const d of opts.filterDrivers ?? []) {
    checkDriverName(d);
    drivers.add(d);
  }
  for (const d of [...drivers].sort()) c(`filter.${d}.required=true`);
  if (opts.attrTree !== void 0) {
    if (!OID.test(opts.attrTree)) fail(`attrTree must be a 40- or 64-hex oid, got ${JSON.stringify(opts.attrTree)}`);
    c(`attr.tree=${opts.attrTree}`);
  }
  if (opts.class === "refupdate") {
    c("core.logAllRefUpdates=always");
    c("core.fsync=committed,reference,index");
    c("core.fsyncMethod=batch");
  } else if (sub === "fetch") {
    c("core.logAllRefUpdates=always");
  }
  if (sub === "push") {
    c("push.pushOption=");
    c("push.gpgSign=false");
    c("push.followTags=false");
    c("push.recurseSubmodules=no");
  }
  if (opts.class === "network") {
    c("http.lowSpeedLimit=1000");
    c("http.lowSpeedTime=10");
  }
  if (opts.config !== void 0) {
    for (const key of Object.keys(opts.config).sort()) {
      const value = opts.config[key];
      if (key.length === 0 || /[=\s\0]/.test(key) || !key.includes(".")) fail(`invalid config key ${JSON.stringify(key)}`);
      if (/[\0\r\n]/.test(value)) fail(`invalid config value for ${key}`);
      if (isForcedKey(key)) fail(`config key ${JSON.stringify(key)} is forced by the runner`);
      pre.push("-c", `${key}=${value}`);
    }
  }
  if (MERGE_COMMANDS.has(sub)) pre.push(...MERGE_FLAGS);
  const post = [];
  if (DIFF_FAMILY.has(sub)) post.push(...DIFF_FLAGS);
  if (sub === "fetch") post.push(...FETCH_FLAGS);
  return {
    argv: [...pre, sub, ...post, ...args.slice(1)],
    env: buildEnv(opts, base)
  };
}

// src/git/runner.ts
var WATCHDOG = { fetch: 45e3, push: 9e4, readHash: 12e4 };
var NEVER_KILLED = /* @__PURE__ */ new Set(["update-ref", "update-index", "commit-tree", "read-tree"]);
var CLOSE_GRACE_MS = 5e3;
var DRAIN_TURNS_MAX = 64;
function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c" || a === "-C") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return void 0;
}
function watchdogMs(args, cls) {
  const sub = subcommandOf(args);
  if (sub === void 0 || NEVER_KILLED.has(sub)) return null;
  if (sub === "push") return WATCHDOG.push;
  if (sub === "fetch") return WATCHDOG.fetch;
  if (cls === "network") return WATCHDOG.fetch;
  if (sub === "add" || sub === "hash-object") return WATCHDOG.readHash;
  if (sub === "cat-file" && args.includes("--filters")) return WATCHDOG.readHash;
  return null;
}
function systemRootOf(env) {
  let root = null;
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() !== "SYSTEMROOT") continue;
    if (!/^[A-Za-z]:[\\/]/.test(v) || !win326.isAbsolute(v) || root !== null && v !== root) return null;
    root = v;
  }
  return root;
}
var TASKKILL_TIMEOUT_MS = 1e4;
function killTree(child, deps, systemRoot2) {
  const pid = child.pid;
  if (pid === void 0 || child.exitCode !== null || child.signalCode !== null) return;
  const killGit = () => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  };
  if (process.platform === "win32") {
    const testCmd = deps.winKillCommand?.(pid);
    if (testCmd === void 0 && systemRoot2 === null) {
      killGit();
      return;
    }
    const cmd = testCmd ?? { file: win326.join(systemRoot2, "System32", "taskkill.exe"), args: ["/PID", String(pid), "/T", "/F"] };
    const r = spawnSync(cmd.file, cmd.args, {
      ...systemRoot2 !== null ? { cwd: systemRoot2 } : {},
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS
    });
    if (r.error !== void 0 || r.status !== 0) killGit();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }
}
function createGitRunner(deps) {
  const platform = deps.platform ?? process.platform;
  const gitPath = deps.gitPath ?? "git";
  const systemRoot2 = systemRootOf(deps.daemonEnv);
  const base = {
    hooksPath: deps.hooksPath,
    platform,
    daemonEnv: deps.daemonEnv,
    testBuild: deps.testBuild ?? false,
    ...deps.sshCommand !== void 0 ? { sshCommand: deps.sshCommand } : {}
  };
  return {
    run(args, opts) {
      const inv = buildGitInvocation(args, opts, base);
      const sub = subcommandOf(args);
      const neverKilled = sub !== void 0 && NEVER_KILLED.has(sub);
      const limit = neverKilled ? null : deps.watchdogOverrideMs ?? watchdogMs(args, opts.class);
      const signal = neverKilled ? void 0 : opts.abort;
      const started = deps.clock.monoMs();
      return new Promise((resolve) => {
        const out = [];
        const err = [];
        let killed = false;
        let aborted = false;
        let settled = false;
        let exited = false;
        let child;
        let timer;
        let grace;
        const onAbort = () => {
          if (settled || exited || child === void 0) return;
          aborted = true;
          killTree(child, deps, systemRoot2);
        };
        const finish = (code, extraErr) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
          signal?.removeEventListener("abort", onAbort);
          if (extraErr !== void 0) err.push(Buffer.from(extraErr, "utf8"));
          resolve({
            code,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            killedByWatchdog: killed,
            aborted,
            durationMs: deps.clock.monoMs() - started
          });
        };
        if (signal?.aborted === true) {
          aborted = true;
          finish(-1);
          return;
        }
        let proc;
        try {
          proc = spawn2(gitPath, inv.argv, {
            cwd: opts.cwd,
            env: inv.env,
            stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
            windowsHide: true,
            // POSIX: own process group, so kill(-pid) reaches grandchildren.
            detached: process.platform !== "win32"
          });
        } catch (e) {
          finish(-1, `spawn failed: ${e.message}`);
          return;
        }
        child = proc;
        let chunks = 0;
        proc.stdout.on("data", (b) => {
          chunks++;
          out.push(b);
        });
        proc.stderr.on("data", (b) => {
          chunks++;
          err.push(b);
        });
        proc.on("error", (e) => finish(-1, `spawn failed: ${e.message}`));
        let exitCode = null;
        const drain = (seen, turns) => {
          setImmediate(() => {
            if (settled) return;
            if (chunks !== seen && turns < DRAIN_TURNS_MAX) {
              drain(chunks, turns + 1);
              return;
            }
            proc.stdout?.destroy();
            proc.stderr?.destroy();
            finish(exitCode ?? -1);
          });
        };
        proc.on("exit", (code) => {
          exited = true;
          exitCode = code;
          grace = setTimeout(() => drain(chunks, 0), CLOSE_GRACE_MS);
        });
        proc.on("close", (code) => finish(code ?? exitCode ?? -1));
        if (opts.stdin && proc.stdin) {
          proc.stdin.on("error", () => {
          });
          proc.stdin.end(opts.stdin);
        }
        if (limit !== null) {
          timer = setTimeout(() => {
            if (exited) return;
            killed = true;
            killTree(proc, deps, systemRoot2);
          }, limit);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  };
}

// src/viz/source/vizGitArgv.ts
var OID_RE2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var REF_RE = /^refs\/cowork-remote\/[^\s]+\/board$/;
var N_RE = /^(0|[1-9][0-9]{0,9})$/;
var FOR_EACH_REF_FORMAT = "--format=%(objectname) %(refname)";
var REMOTE_NAMESPACE = "refs/cowork-remote/";
function vizGitArgvOk(args, placeholder) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return false;
  const stands = (v) => placeholder !== void 0 && v === placeholder;
  const is = (i, token) => args[i] === token && !stands(token);
  const slot = (i, re) => {
    const v = args[i];
    return v !== void 0 && (stands(v) || re.test(v));
  };
  const counted = (i, flag) => {
    const v = args[i];
    if (v === void 0 || stands(v) || !v.startsWith(flag)) return false;
    const n = v.slice(flag.length);
    return stands(n) || N_RE.test(n);
  };
  switch (args.length > 0 && !stands(args[0]) ? args[0] : "") {
    case "version":
      return args.length === 1;
    case "rev-parse":
      return args.length === 4 && is(1, "--verify") && is(2, "-q") && slot(3, REF_RE);
    case "for-each-ref":
      return args.length === 3 && is(1, FOR_EACH_REF_FORMAT) && is(2, REMOTE_NAMESPACE);
    case "rev-list":
      if (!is(1, "--first-parent")) return false;
      if (args.length === 4) return (is(2, "--count") || counted(2, "--max-count=")) && slot(3, OID_RE2);
      return args.length === 5 && counted(2, "--skip=") && counted(3, "--max-count=") && slot(4, OID_RE2);
    case "cat-file":
      return args.length === 2 && (is(1, "--batch-check") || is(1, "--batch"));
    default:
      return false;
  }
}

// src/viz/source/vizGit.ts
var VIZ_GIT_CONFIG = Object.freeze({
  "protocol.allow": "never",
  "protocol.file.allow": "never",
  "protocol.git.allow": "never",
  "protocol.http.allow": "never",
  "protocol.https.allow": "never",
  "protocol.ssh.allow": "never"
});
var VIZ_GIT_ENV = Object.freeze({ GIT_NO_LAZY_FETCH: "1" });
var VIZ_GIT_WATCHDOG_MS = 12e4;
var VizGitRefused = class extends Error {
  constructor(args) {
    super(`VizGit: git argv outside the viewer allowlist ${JSON.stringify(args).slice(0, 200)}`);
    this.name = "VizGitRefused";
  }
};
var REMOTE_NAMESPACE2 = "refs/cowork-remote/";
function absolutePath(p) {
  if (typeof p !== "string") return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(p);
  return isAbsolute2(p);
}
function vizEnv(env) {
  const forced = new Set(Object.keys(VIZ_GIT_ENV).map((k) => k.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!forced.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...VIZ_GIT_ENV };
}
function vizGitRunner(o) {
  if (!absolutePath(o.gitPath)) throw new Error(`vizGitRunner: the git path must be absolute, got ${JSON.stringify(o.gitPath)}`);
  if (!absolutePath(o.dataDir)) throw new Error("vizGitRunner: the data directory must be absolute");
  return createGitRunner({
    clock: o.clock,
    hooksPath: join3(o.dataDir, "viz-no-hooks"),
    daemonEnv: vizEnv(o.env),
    gitPath: o.gitPath,
    watchdogOverrideMs: VIZ_GIT_WATCHDOG_MS
  });
}
function abortingRunner(runner, signal) {
  return { run: (args, opts) => runner.run(args, { ...opts, abort: signal }) };
}
function createVizGit(o) {
  if (!absolutePath(o.gitDir)) throw new Error("createVizGit: the git dir must be absolute");
  if (!absolutePath(o.dataDir)) throw new Error("createVizGit: the data directory must be absolute");
  const { runner, gitDir, dataDir } = o;
  const call = async (args, stdin, okCodes = [0]) => {
    if (!vizGitArgvOk(args)) throw new VizGitRefused(args);
    const r = await runner.run(args, { class: "local", cwd: dataDir, gitDir, config: VIZ_GIT_CONFIG, ...stdin === null ? {} : { stdin } });
    if (!okCodes.includes(r.code)) throw new GitCommandError(args, r.code, r.stderr);
    return r;
  };
  const lines = (r) => r.stdout.toString("utf8").split("\n").filter((l) => l.length > 0);
  return {
    gitDir,
    run: (args, opts) => call(args, opts.stdin),
    async version() {
      return parseGitVersion((await call(["version"], null)).stdout.toString("utf8"));
    },
    async revParse(ref) {
      const r = await call(["rev-parse", "--verify", "-q", ref], null, [0, 1]);
      return r.code === 0 ? parseOid(r.stdout.toString("utf8")) : null;
    },
    async remoteRefs() {
      const r = await call(["for-each-ref", "--format=%(objectname) %(refname)", "refs/cowork-remote/"], null);
      const out = [];
      for (const line of lines(r)) {
        const sp = line.indexOf(" ");
        const ref = line.slice(sp + 1);
        if (sp > 0 && ref.startsWith(REMOTE_NAMESPACE2)) out.push({ ref, oid: parseOid(line.slice(0, sp)) });
      }
      return out;
    },
    async chainCount(tip) {
      const text = (await call(["rev-list", "--first-parent", "--count", tip], null)).stdout.toString("utf8").trim();
      const n = Number(text);
      if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(n)) throw new Error(`rev-list --count: unexpected output ${JSON.stringify(text.slice(0, 40))}`);
      return n;
    },
    async chain(tip, skip, max) {
      return lines(await call(["rev-list", "--first-parent", `--skip=${skip}`, `--max-count=${max}`, tip], null)).map((l) => parseOid(l));
    }
  };
}

// src/viz/main.ts
var IDLE_MS = 6e5;
var LIFETIME_MS = 864e5;
var PLUGIN_CHECK_MS = 3e4;
var ROOM_INITS_MAX = 4;
var LIFE_CHECK_MS = 1e3;
var SALT_BYTES = 32;
var LOG_DIR2 = "log";
var HEX64 = /^[0-9a-f]{64}$/;
var START_FAILED = Object.freeze({ refuse: "RF_VIZ_START_FAILED" });
function absolutePath2(p) {
  if (p.length === 0 || isUncOrDevice(p)) return false;
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/");
}
function parseServeArgv(argv2) {
  if (argv2[0] !== "serve") return null;
  let dataDir = null;
  let lang = null;
  let sha2562 = null;
  let git = null;
  let demo = null;
  const repos = [];
  for (let i = 1; i < argv2.length; i++) {
    const flag = argv2[i];
    if (flag === "--demo" || flag.startsWith("--demo=")) {
      if (demo !== null) return null;
      if (flag === "--demo") {
        demo = true;
      } else {
        const p = flag.slice("--demo=".length);
        if (!absolutePath2(p)) return null;
        demo = p;
      }
      continue;
    }
    const value = argv2[i + 1];
    if (value === void 0) return null;
    i++;
    switch (flag) {
      case "--data-dir":
        if (dataDir !== null || !absolutePath2(value)) return null;
        dataDir = value;
        break;
      case "--lang":
        if (lang !== null || !LANGS.includes(value)) return null;
        lang = value;
        break;
      case "--sha256":
        if (sha2562 !== null || !HEX64.test(value)) return null;
        sha2562 = value;
        break;
      case "--git":
        if (git !== null || !absolutePath2(value)) return null;
        git = value;
        break;
      case "--repo":
        if (!absolutePath2(value)) return null;
        repos.push(value);
        break;
      default:
        return null;
    }
  }
  if (dataDir === null || lang === null || sha2562 === null) return null;
  if (git !== null !== repos.length > 0) return null;
  if (demo !== null && repos.length > 0) return null;
  return { dataDir, lang, sha256: sha2562, repos, demo, git };
}
async function fileHash(fs, path2) {
  try {
    return createHash7("sha256").update(await fs.readFile(path2)).digest("hex");
  } catch {
    return null;
  }
}
var ViewerHub = class extends StreamHub {
  constructor(clock, closed) {
    super(clock);
    this.closed = closed;
  }
  attach(out, lastEventId) {
    super.attach(out, lastEventId);
    out.onClose(() => this.closed());
  }
};
function demoRooms(buf, salt, storeDeps) {
  const captionCodes = new Set(DEMO_CAPTION_CODES.filter((c) => EN_VIZ[c] !== void 0));
  const parsed = parseDemoLog(buf, captionCodes);
  if ("line" in parsed) return { refuse: "RF_VIZ_DEMO_INVALID", line: parsed.line };
  const ids = new Map(parsed.rooms.map((r) => [r.room, demoRoomId(salt, r.room)]));
  const stores = parsed.rooms.map((r) => {
    const spec = { id: ids.get(r.room), kind: "demo", label: r.name, branch: r.branch, gitDir: null, boardRef: null, canonicalRoot: null };
    return new RoomStore(spec, new DemoRoomSource(r, parsed.commits.get(r.room) ?? []), storeDeps);
  });
  const captions = parsed.captions.flatMap((c) => {
    const id = ids.get(c.room);
    return id === void 0 ? [] : [{ ...c, room: id }];
  });
  return { stores, inits: stores.map((s) => () => s.init()), captions, demo: true };
}
async function startViewer(a, d) {
  const { clock, fs } = d;
  const path2 = d.platform === "win32" ? win327 : posix5;
  const verdict = await verifyDataDir(a.dataDir, { fs, probe: d.ownerProbe, platform: d.platform, create: false });
  if (!verdict.ok) return START_FAILED;
  const tokens = new TokenAuthority(d.random, clock);
  const logDir = path2.join(a.dataDir, LOG_DIR2);
  let log;
  try {
    await cleanupVizLogs(fs, clock, logDir);
    log = await openVizLog({ fs, clock, dir: logDir, instance: tokens.instance });
  } catch {
    return START_FAILED;
  }
  const refuse4 = async (r) => {
    try {
      log.write(r.refuse, r.line === void 0 ? void 0 : { line: r.line });
    } catch {
    }
    await log.flush();
    return r;
  };
  if (await fileHash(fs, d.selfPath) !== a.sha256) return refuse4(START_FAILED);
  const storeDeps = { clock, fs, reader: d.reader, log, viewerVersion: d.viewerVersion, machineMonoMs: () => d.machineMonoMs() };
  const salt = d.random.bytes(SALT_BYTES);
  const abort = new AbortController();
  let rooms;
  if (d.stores !== void 0) {
    const stores = [...d.stores];
    rooms = {
      stores,
      captions: [],
      demo: a.demo !== null,
      inits: stores.map((s) => () => typeof s.init === "function" ? s.init() : s.ready)
    };
  } else if (a.demo !== null) {
    let buf;
    if (a.demo === true) {
      const bundled = Buffer.from(d.assets.bundledDemo, "utf8");
      buf = bundled.length <= BUNDLED_DEMO_MAX_BYTES ? bundled : { line: 0 };
    } else {
      buf = await readDemoFile(a.demo, d.reader);
    }
    if (!Buffer.isBuffer(buf)) return refuse4({ refuse: "RF_VIZ_DEMO_INVALID", line: 0 });
    const r = demoRooms(buf, salt, storeDeps);
    if ("refuse" in r) return refuse4(r);
    rooms = r;
  } else {
    if (a.repos.length === 0 || a.git === null) return refuse4({ refuse: "RF_VIZ_NO_ROOMS" });
    const o = { clock, dataDir: a.dataDir, env: d.env, gitPath: a.git };
    let runner;
    try {
      runner = abortingRunner(d.gitRunner !== void 0 ? d.gitRunner(o) : vizGitRunner(o), abort.signal);
    } catch {
      return refuse4({ refuse: "START_TOOL_VERSION" });
    }
    try {
      if (!meetsFloor(await createVizGit({ runner, gitDir: a.dataDir, dataDir: a.dataDir }).version())) return refuse4({ refuse: "START_TOOL_VERSION" });
    } catch {
      return refuse4({ refuse: "START_TOOL_VERSION" });
    }
    let found;
    try {
      found = await discoverRooms(a.repos, {
        fs,
        reader: d.reader,
        git: (gitDir) => createVizGit({ runner, gitDir, dataDir: a.dataDir }),
        salt,
        platform: d.platform,
        probe: realRootProbe
      });
    } catch {
      return refuse4({ refuse: "RF_VIZ_REPO_NOT_LIVE" });
    }
    if ("refuse" in found) return refuse4({ refuse: found.refuse });
    const stores = found.rooms.map((spec) => new RoomStore(spec, new GitRoomSource(spec, createVizGit({ runner, gitDir: spec.gitDir, dataDir: a.dataDir }), { fs, clock }), storeDeps));
    rooms = { stores, inits: stores.map((s) => () => s.init()), captions: [], demo: false };
  }
  const start = anchorNow(clock);
  let idle = start;
  const activity = () => {
    idle = anchorNow(clock);
  };
  const hub = new ViewerHub(clock, activity);
  const handles = createHandleTable();
  const api = createWorldApi({ stores: rooms.stores, handles, hub, clock, demo: rooms.demo, captions: rooms.captions });
  let stop = async () => {
  };
  const bound = await createServer({
    clock,
    log,
    hub,
    tokens,
    api,
    assets: { appJs: d.assets.appJs, appCss: d.assets.appCss },
    onActivity: activity,
    onLaunchReused: () => {
      void stop("VIZ_EXIT_LAUNCH_REUSED");
    }
  });
  if ("refuse" in bound) {
    abort.abort();
    return refuse4({ refuse: bound.refuse });
  }
  const server = bound;
  let stopping = null;
  let stopPoll = null;
  let lifeTimer = null;
  let markExited = () => {
  };
  const exited = new Promise((resolve) => {
    markExited = resolve;
  });
  stop = (reason) => {
    stopping ??= (async () => {
      lifeTimer?.cancel();
      lifeTimer = null;
      try {
        log.write(reason);
      } catch {
      }
      hub.close();
      abort.abort();
      await stopPoll?.();
      await server.close();
      await log.flush();
      markExited(reason);
    })();
    return stopping;
  };
  setImmediate(() => {
    if (stopping !== null) return;
    let next = 0;
    const worker = async () => {
      while (stopping === null && next < rooms.inits.length) {
        const init = rooms.inits[next];
        next += 1;
        try {
          await init();
        } catch {
        }
      }
    };
    for (let i = 0; i < Math.min(ROOM_INITS_MAX, rooms.inits.length); i++) void worker();
    stopPoll = startPoll(rooms.stores, pollSinkFor(api, hub, handles, clock, log), clock);
  });
  let pluginAt = start;
  const due = async () => {
    if (hub.open() > 0) activity();
    if (!tokens.redeemed() && tokens.launchExpired()) return "VIZ_EXIT_LAUNCH_UNUSED";
    if (ownStaleness(clock, start) > LIFETIME_MS) return "VIZ_EXIT_LIFETIME";
    if (ownStaleness(clock, idle) > IDLE_MS) return "VIZ_EXIT_IDLE";
    if (elapsedMono(clock, pluginAt) >= PLUGIN_CHECK_MS) {
      pluginAt = anchorNow(clock);
      if (await fileHash(fs, d.selfPath) !== a.sha256) return "VIZ_EXIT_PLUGIN_REMOVED";
    }
    return null;
  };
  const check2 = async () => {
    lifeTimer = null;
    if (stopping !== null) return;
    const reason = await due();
    if (reason !== null) await stop(reason);
    else if (stopping === null) lifeTimer = clockTimer(clock, LIFE_CHECK_MS, () => {
      void check2();
    });
  };
  lifeTimer = clockTimer(clock, LIFE_CHECK_MS, () => {
    void check2();
  });
  d.signals?.(() => {
    void stop("VIZ_EXIT_SIGNAL");
  });
  return { port: server.port, launch: tokens.launch, instance: tokens.instance, exited, stop };
}
function writeReady(value) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      process.stdout.once("error", finish);
      process.stdout.write(`${JSON.stringify(value)}
`, () => {
        try {
          process.stdout.end(finish);
        } catch {
          finish();
        }
      });
    } catch {
      finish();
    }
  });
}
function realDeps(assets) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== void 0) env[k] = v;
  return {
    fs: realFs,
    reader: realBoundedReader,
    clock: realClock,
    random: realRandom,
    ownerProbe: realOwnerProbe,
    machineMonoMs,
    env,
    platform: process.platform,
    selfPath: fileURLToPath(import.meta.url),
    assets,
    viewerVersion: PLUGIN_VERSION,
    signals: (cb) => {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => cb(sig));
    }
  };
}
async function main(argv2, assets) {
  let code = 1;
  let written = false;
  const ready = (value) => {
    written = true;
    return writeReady(value);
  };
  try {
    registerCatalog("en", EN_VIZ);
    registerReasonCodes(REASON_CODES);
    const a = parseServeArgv(argv2);
    let r = START_FAILED;
    if (a !== null) {
      try {
        r = await startViewer(a, realDeps(assets));
      } catch {
        r = START_FAILED;
      }
    }
    if ("refuse" in r) {
      await ready(r.line === void 0 ? { v: 1, refuse: r.refuse } : { v: 1, refuse: r.refuse, line: r.line });
    } else {
      await ready({ v: 1, port: r.port, launch: r.launch });
      await r.exited;
      code = 0;
    }
  } catch {
    if (!written) await writeReady({ v: 1, refuse: START_FAILED.refuse });
    code = 1;
  }
  process.exit(code);
}

// src/entry/viz.ts
var argv = process.argv.slice(2);
if (argv[0] === "serve") {
  await main(argv, VIZ_ASSETS);
} else if (argv.includes("--version")) {
  process.stdout.write(`cowork-sync viz ${PLUGIN_VERSION}
`);
}
