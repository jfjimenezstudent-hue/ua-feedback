/* ---------- Minimal QR code generator (byte mode, error correction M, versions 1-9) ---------- */
function makeQR(text){
  const data=Array.from(new TextEncoder().encode(text));
  const T={1:[10,1,16,0,0],2:[16,1,28,0,0],3:[26,1,44,0,0],4:[18,2,32,0,0],5:[24,2,43,0,0],6:[16,4,27,0,0],7:[18,4,31,0,0],8:[22,2,38,2,39],9:[22,3,36,2,37]};
  let v=1;
  for(;v<=9;v++){const q=T[v];if(data.length+2<=q[1]*q[2]+q[3]*q[4])break}
  if(v>9)throw new Error("Link is too long for the QR code");
  const t=T[v],cap=t[1]*t[2]+t[3]*t[4],ecn=t[0];
  const bits=[];const put=(x,l)=>{for(let i=l-1;i>=0;i--)bits.push((x>>i)&1)};
  put(4,4);put(data.length,8);data.forEach(b=>put(b,8));
  put(0,Math.min(4,cap*8-bits.length));
  while(bits.length%8)bits.push(0);
  const cw=[];for(let i=0;i<bits.length;i+=8){let b=0;for(let j=0;j<8;j++)b=b<<1|bits[i+j];cw.push(b)}
  for(let p=0;cw.length<cap;p^=1)cw.push(p?0x11:0xEC);
  const exp=new Array(512),log=new Array(256);
  for(let i=0,x=1;i<255;i++){exp[i]=x;log[x]=i;x<<=1;if(x&256)x^=0x11d}
  for(let i=255;i<512;i++)exp[i]=exp[i-255];
  const mul=(a,b)=>a&&b?exp[log[a]+log[b]]:0;
  let gen=[1];
  for(let i=0;i<ecn;i++){const ng=new Array(gen.length+1).fill(0);for(let j=0;j<gen.length;j++){ng[j]^=gen[j];ng[j+1]^=mul(gen[j],exp[i])}gen=ng}
  const rs=d=>{const r=new Array(ecn).fill(0);for(const b of d){const f=b^r.shift();r.push(0);if(f)for(let i=0;i<ecn;i++)r[i]^=mul(gen[i+1],f)}return r};
  const blocks=[];let o=0;
  for(let i=0;i<t[1];i++){blocks.push(cw.slice(o,o+t[2]));o+=t[2]}
  for(let i=0;i<t[3];i++){blocks.push(cw.slice(o,o+t[4]));o+=t[4]}
  const ecs=blocks.map(rs),out=[],maxd=Math.max(...blocks.map(b=>b.length));
  for(let i=0;i<maxd;i++)blocks.forEach(b=>{if(i<b.length)out.push(b[i])});
  for(let i=0;i<ecn;i++)ecs.forEach(e=>out.push(e[i]));
  const n=17+4*v;
  const M=Array.from({length:n},()=>new Array(n).fill(false));
  const fn=Array.from({length:n},()=>new Array(n).fill(false));
  const set=(r,c,val)=>{if(r>=0&&r<n&&c>=0&&c<n){M[r][c]=val;fn[r][c]=true}};
  const finder=(r,c)=>{for(let i=-1;i<=7;i++)for(let j=-1;j<=7;j++){const on=i>=0&&i<=6&&j>=0&&j<=6&&(i==0||i==6||j==0||j==6||(i>=2&&i<=4&&j>=2&&j<=4));set(r+i,c+j,on)}};
  finder(0,0);finder(0,n-7);finder(n-7,0);
  for(let i=8;i<n-8;i++){set(6,i,i%2==0);set(i,6,i%2==0)}
  const AP={2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46]}[v]||[];
  const last=AP[AP.length-1];
  for(const r of AP)for(const c of AP){
    if((r==6&&c==6)||(r==6&&c==last)||(r==last&&c==6))continue;
    for(let i=-2;i<=2;i++)for(let j=-2;j<=2;j++)set(r+i,c+j,Math.max(Math.abs(i),Math.abs(j))!=1)}
  const reserve=(r,c)=>{if(!fn[r][c])set(r,c,false)};
  for(let i=0;i<9;i++){reserve(8,i);reserve(i,8)}
  for(let i=0;i<8;i++){reserve(8,n-1-i);reserve(n-1-i,8)}
  set(n-8,8,true);
  if(v>=7){let r=v;for(let i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1f25);const vb=(v<<12)|r;
    for(let i=0;i<18;i++){const bit=((vb>>i)&1)===1,a=Math.floor(i/3),b=i%3+n-11;set(a,b,bit);set(b,a,bit)}}
  const dbits=[];out.forEach(b=>{for(let i=7;i>=0;i--)dbits.push((b>>i)&1)});
  const remb=(v>=2&&v<=6)?7:0;for(let i=0;i<remb;i++)dbits.push(0);
  const place=[];let up=true;
  for(let c=n-1;c>0;c-=2){if(c==6)c--;
    for(let i=0;i<n;i++){const r=up?n-1-i:i;for(let d=0;d<2;d++){if(!fn[r][c-d])place.push([r,c-d])}}
    up=!up}
  if(place.length!==dbits.length)throw new Error("QR layout error");
  const mk=[(r,c)=>(r+c)%2==0,(r,c)=>r%2==0,(r,c)=>c%3==0,(r,c)=>(r+c)%3==0,(r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2==0,(r,c)=>(r*c)%2+(r*c)%3==0,(r,c)=>((r*c)%2+(r*c)%3)%2==0,(r,c)=>(((r+c)%2)+(r*c)%3)%2==0];
  const pen=m=>{let p=0;
    for(let a=0;a<2;a++){for(let i=0;i<n;i++){let run=1;for(let j=1;j<n;j++){const x=a?m[j][i]:m[i][j],y=a?m[j-1][i]:m[i][j-1];if(x===y){run++;if(run==5)p+=3;else if(run>5)p++}else run=1}}}
    for(let i=0;i<n-1;i++)for(let j=0;j<n-1;j++){const x=m[i][j];if(x===m[i][j+1]&&x===m[i+1][j]&&x===m[i+1][j+1])p+=3}
    let dark=0;for(const row of m)for(const x of row)if(x)dark++;
    p+=Math.floor(Math.abs(dark*20-n*n*10)/(n*n))*10;return p};
  let best=null,bp=1e9;
  for(let mask=0;mask<8;mask++){
    const m=M.map(r=>r.slice());
    place.forEach(([r,c],i)=>{m[r][c]=(dbits[i]===1)!==mk[mask](r,c)});
    const d=mask;let rem=d;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
    const fb=((d<<10)|rem)^0x5412,g=i=>((fb>>i)&1)===1;
    for(let i=0;i<=5;i++)m[i][8]=g(i);
    m[7][8]=g(6);m[8][8]=g(7);m[8][7]=g(8);
    for(let i=9;i<15;i++)m[8][14-i]=g(i);
    for(let i=0;i<8;i++)m[8][n-1-i]=g(i);
    for(let i=8;i<15;i++)m[n-15+i][8]=g(i);
    m[n-8][8]=true;
    const s=pen(m);if(s<bp){bp=s;best=m}
  }
  return best;
}
function drawQR(canvas,m,px){
  const q=4,n=m.length,size=(n+q*2)*px;canvas.width=canvas.height=size;
  const g=canvas.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,size,size);g.fillStyle="#000";
  for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(m[r][c])g.fillRect((c+q)*px,(r+q)*px,px,px);
}
