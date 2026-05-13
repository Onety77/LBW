import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot, collection, query, orderBy, limit } from "firebase/firestore";
import { db } from "../firebase";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN_CA      = "PASTE_TOKEN_CA_HERE";
const X_URL         = "https://x.com/REPLACE";
const TIMER_DEFAULT = 60 * 1000;
const MIN_BUY_SOL   = 0.1;

// ── Helpers ───────────────────────────────────────────────────────────────────
const short   = (a) => a ? a.slice(0,4)+"..."+a.slice(-4) : "—";
const fmtSOL  = (n) => (!n && n !== 0) ? "0.0000" : n.toFixed(4);
const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const t = Math.floor(ms/1000);
  return String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0");
};
const timeAgo = (ms) => {
  const s = Math.floor((Date.now()-ms)/1000);
  if (s < 5)    return "just now";
  if (s < 60)   return s+"s ago";
  if (s < 3600) return Math.floor(s/60)+"m ago";
  return Math.floor(s/3600)+"h ago";
};

function useWindowWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(()=>{
    const h=()=>setW(window.innerWidth);
    window.addEventListener("resize",h);
    return ()=>window.removeEventListener("resize",h);
  },[]);
  return w;
}

// ── Ticker ────────────────────────────────────────────────────────────────────
function TickerBar({stats}) {
  const items = [
    "LAST BUYER WINS",
    "MIN BUY: ◎"+MIN_BUY_SOL,
    "CURRENT POT: ◎"+(stats?.currentPotSOL?.toFixed(4)||"—"),
    "TOTAL PAID: ◎"+(stats?.totalPaid?.toFixed(4)||"0.0000"),
    "ROUNDS WON: "+(stats?.totalRounds||0),
    "LAST BUYER WINS",
    "MIN BUY: ◎"+MIN_BUY_SOL,
    "CURRENT POT: ◎"+(stats?.currentPotSOL?.toFixed(4)||"—"),
    "TOTAL PAID: ◎"+(stats?.totalPaid?.toFixed(4)||"0.0000"),
    "ROUNDS WON: "+(stats?.totalRounds||0),
  ];
  return (
    <div style={{borderTop:"1px solid var(--border)",borderBottom:"1px solid var(--border)",overflow:"hidden",padding:"8px 0",background:"var(--bg2)"}}>
      <div style={{display:"flex",gap:40,animation:"ticker-left 20s linear infinite",whiteSpace:"nowrap",width:"max-content"}}>
        {items.map((item,i)=>(
          <span key={i} style={{fontFamily:"'Space Mono',monospace",fontSize:10,color:"var(--grey)",letterSpacing:2}}>
            <span style={{color:"var(--red)",marginRight:14}}>▶</span>{item}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Live buys feed ─────────────────────────────────────────────────────────────
function BuyFeed({buys}) {
  if (!buys || buys.length === 0) {
    return (
      <div style={{border:"1px solid var(--border)",borderRadius:4,background:"var(--bg2)",padding:"20px",textAlign:"center"}}>
        <div style={{fontFamily:"'Space Mono',monospace",fontSize:10,color:"var(--greyDim)",letterSpacing:3}}>WAITING FOR FIRST BUY...</div>
        <div style={{fontFamily:"'Space Mono',monospace",fontSize:9,color:"var(--greyDim)",marginTop:6,opacity:0.5}}>min ◎{MIN_BUY_SOL} SOL to appear</div>
      </div>
    );
  }
  return (
    <div style={{border:"1px solid var(--border)",borderRadius:4,overflow:"hidden",background:"var(--bg2)"}}>
      <div style={{padding:"8px 14px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:8,background:"var(--bg3)"}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:"var(--green)",boxShadow:"0 0 8px rgba(57,255,20,0.8)",animation:"blink 1s ease infinite",flexShrink:0}}/>
        <span style={{fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:3,color:"var(--grey)"}}>LIVE BUYS</span>
        <span style={{fontFamily:"'Space Mono',monospace",fontSize:9,color:"var(--greyDim)",marginLeft:"auto"}}>{buys.length} this round</span>
      </div>
      <div style={{maxHeight:280,overflowY:"auto"}}>
        {buys.map((buy,i)=>{
          const isLeader = buy.isLeader;
          return (
            <div key={buy.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:i<buys.length-1?"1px solid rgba(255,255,255,0.04)":"none",background:isLeader?"rgba(57,255,20,0.05)":"transparent",animation:i===0?"slide-up 0.3s ease":"none"}}>
              <div style={{width:22,height:22,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:isLeader?"var(--green)":"var(--greyDim)",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,color:isLeader?"#fff":"var(--grey)",flexShrink:0,boxShadow:isLeader?"0 0 10px rgba(57,255,20,0.5)":"none"}}>
                {isLeader?"★":i+1}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"'Space Mono',monospace",fontSize:isLeader?13:11,color:isLeader?"var(--green)":"var(--grey)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:isLeader?700:400}}>
                  {short(buy.wallet)}
                </div>
                {isLeader&&<div style={{fontFamily:"'Inter',sans-serif",fontSize:8,letterSpacing:3,color:"var(--red)",marginTop:2,opacity:0.8}}>CURRENT LEADER</div>}
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"'Space Mono',monospace",fontSize:12,color:isLeader?"var(--green)":"var(--white)",fontWeight:isLeader?700:400}}>◎ {fmtSOL(buy.amount)}</div>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"var(--greyDim)",marginTop:2}}>{buy.timestamp?timeAgo(buy.timestamp.toMillis()):""}</div>
              </div>
              {buy.sig&&(
                <a href={"https://solscan.io/tx/"+buy.sig} target="_blank" rel="noreferrer" style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"var(--greyDim)",textDecoration:"none",flexShrink:0}}>↗</a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Home({navigate}) {
  const width    = useWindowWidth();
  const isMobile = width < 768;

  const [stats,    setStats]    = useState(null);
  const [winners,  setWinners]  = useState([]);
  const [buys,     setBuys]     = useState([]);
  const [countdown,setCountdown]= useState(TIMER_DEFAULT);
  const [copiedCA, setCopiedCA] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const winAtRef = useRef(null);
  const isLive   = TOKEN_CA !== "PASTE_TOKEN_CA_HERE";

  useEffect(()=>{
    return onSnapshot(doc(db,"lbw_stats","global"),snap=>{
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.nextWinAt) {
        winAtRef.current = d.nextWinAt.toMillis();
        setCountdown(Math.max(d.nextWinAt.toMillis()-Date.now(),0));
      }
    });
  },[]);

  useEffect(()=>{
    const q = query(collection(db,"lbw_history"),orderBy("timestamp","desc"),limit(5));
    return onSnapshot(q,snap=>setWinners(snap.docs.map(d=>({id:d.id,...d.data()}))));
  },[]);

  useEffect(()=>{
    const q = query(collection(db,"lbw_buys"),orderBy("timestamp","desc"),limit(15));
    return onSnapshot(q,snap=>setBuys(snap.docs.map(d=>({id:d.id,...d.data()}))));
  },[]);

  useEffect(()=>{
    const id = setInterval(()=>{
      if (winAtRef.current) {
        const rem = winAtRef.current-Date.now();
        setCountdown(rem>0?rem:0);
      }
    },500);
    return ()=>clearInterval(id);
  },[]);

  const copyCA=()=>{
    if (!isLive) return;
    navigator.clipboard.writeText(TOKEN_CA);
    setCopiedCA(true);
    setTimeout(()=>setCopiedCA(false),2200);
  };

  const urgent      = countdown < 30000 && countdown > 0;
  const isWaiting   = countdown === 0;
  const lastBuyer   = stats?.lastBuyer;
  const currentPot  = stats?.currentPotSOL ?? null;
  const totalPaid   = stats?.totalPaid     ?? 0;
  const totalRounds = stats?.totalRounds   ?? 0;
  const biggestWin  = stats?.biggestWin    ?? 0;

  return (
    <div className="page" style={{minHeight:"100vh",display:"flex",flexDirection:"column"}}>

      {/* ── HEADER ── */}
      <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"12px 16px":"16px 28px",borderBottom:"1px solid var(--border)",background:"var(--bg)",position:"fixed",top:0,left:0,right:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <img src="/logo.png" alt="LBW" style={{width:30,height:30,borderRadius:4,objectFit:"cover"}}/>
          <div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:isMobile?16:20,letterSpacing:"0.1em",color:"var(--white)"}}>LAST BUYER WINS</div>
            {!isMobile&&<div style={{fontFamily:"'Space Mono',monospace",fontSize:8,color:"var(--grey)",letterSpacing:3,marginTop:-2}}>ON SOLANA</div>}
          </div>
        </div>

        <nav style={{display:"flex",alignItems:"center",gap:24}} className="hide-mobile">
          {[["HOME",()=>navigate("home")],["HISTORY",()=>navigate("history")]].map(([label,fn])=>(
            <button key={label} onClick={fn} style={{background:"none",border:"none",cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:12,fontWeight:600,letterSpacing:3,color:"var(--grey)",transition:"color 0.2s"}}
              onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
              onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
            >{label}</button>
          ))}
          <a href={X_URL} target="_blank" rel="noreferrer" style={{fontFamily:"'Inter',sans-serif",fontSize:12,fontWeight:600,letterSpacing:3,color:"var(--grey)",textDecoration:"none"}}
            onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
            onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
          >𝕏</a>
        </nav>

        <button onClick={()=>setMenuOpen(o=>!o)} className="hide-desktop" style={{background:"none",border:"1px solid var(--border)",borderRadius:4,cursor:"pointer",color:"var(--grey)",padding:"6px 10px",fontSize:14,lineHeight:1}}>
          {menuOpen?"✕":"☰"}
        </button>
      </header>

      {menuOpen&&(
        <div style={{position:"fixed",top:55,left:0,right:0,background:"var(--bg2)",borderBottom:"1px solid var(--border)",zIndex:99,padding:"12px 16px 20px"}}>
          {[["HOME",()=>{navigate("home");setMenuOpen(false);}],["HISTORY",()=>{navigate("history");setMenuOpen(false);}]].map(([label,fn])=>(
            <button key={label} onClick={fn} style={{display:"block",width:"100%",background:"none",border:"none",cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:600,letterSpacing:3,color:"var(--grey)",textAlign:"left",padding:"12px 0",borderBottom:"1px solid var(--border)"}}>
              {label}
            </button>
          ))}
          <a href={X_URL} target="_blank" rel="noreferrer" style={{display:"block",marginTop:12,fontFamily:"'Inter',sans-serif",fontSize:13,color:"var(--grey)",textDecoration:"none",letterSpacing:2}}>𝕏 TWITTER</a>
        </div>
      )}

      {/* Ticker */}
      <div style={{marginTop:isMobile?55:65}}>
        <TickerBar stats={stats}/>
      </div>

      {/* ── HERO ── */}
      <section style={{padding:isMobile?"32px 16px 40px":"60px 24px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",width:isMobile?300:600,height:isMobile?300:600,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,32,32,0.06) 0%, transparent 70%)",pointerEvents:"none",animation:urgent?"pulse-red 1s ease-in-out infinite":"none"}}/>

        {/* Status */}
        <div style={{fontFamily:"'Space Mono',monospace",fontSize:isMobile?9:11,letterSpacing:4,color:urgent?"var(--green)":"var(--grey)",marginBottom:isMobile?16:24,animation:urgent?"blink 1s ease infinite":"none"}}>
          {isWaiting?"⏳ PROCESSING...":urgent?"⚠ FINAL COUNTDOWN":"● LIVE"}
        </div>

        {/* Countdown */}
        <div style={{fontFamily:"'Space Mono',monospace",fontSize:isMobile?"clamp(64px,20vw,96px)":"clamp(80px,14vw,160px)",fontWeight:700,lineHeight:1,color:urgent?"var(--red)":"var(--white)",letterSpacing:"-0.02em",animation:urgent?"urgent-shake 0.5s ease infinite":"none",textShadow:urgent?"0 0 40px rgba(255,32,32,0.6)":"none",marginBottom:8,position:"relative",zIndex:1}}>
          {fmtTime(countdown)}
        </div>

        <div style={{fontFamily:"'Inter',sans-serif",fontSize:isMobile?10:12,fontWeight:600,letterSpacing:isMobile?4:6,color:"var(--grey)",marginBottom:isMobile?24:40}}>
          {isWaiting?"DETERMINING WINNER...":"UNTIL NEXT WINNER"}
        </div>

        {/* Pot box */}
        <div style={{textAlign:"center",marginBottom:isMobile?24:40,padding:isMobile?"16px 24px":"20px 48px",border:"1px solid "+(urgent?"var(--red)":"var(--greenBorder)"),borderRadius:4,background:urgent?"rgba(255,32,32,0.05)":"rgba(57,255,20,0.03)",transition:"all 0.3s",animation:urgent?"pulse-red 1.5s ease-in-out infinite":"none",width:isMobile?"100%":"auto",maxWidth:isMobile?"none":400}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",marginBottom:8}}>CURRENT POT</div>
          <div style={{fontFamily:"'Space Mono',monospace",fontSize:isMobile?"clamp(24px,8vw,36px)":"clamp(28px,5vw,48px)",fontWeight:700,color:"var(--white)"}}>
            ◎ {fmtSOL(currentPot)}
          </div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)",marginTop:6}}>goes to the last qualifying buyer</div>
        </div>

        {/* CTA */}
        <div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:10,width:isMobile?"100%":"auto",maxWidth:isMobile?360:"none",justifyContent:"center"}}>
          <a href={"https://pump.fun/coin/"+TOKEN_CA} target="_blank" rel="noreferrer" style={{width:isMobile?"100%":"auto"}}>
            <button className="btn-red" style={{fontSize:14,padding:"14px 32px",width:isMobile?"100%":"auto"}}>BUY NOW ↗</button>
          </a>
          <button onClick={()=>navigate("history")} className="btn-outline" style={{width:isMobile?"100%":"auto"}}>WINNERS HISTORY</button>
        </div>

        <div style={{marginTop:16,fontFamily:"'Space Mono',monospace",fontSize:10,color:"var(--greyDim)",letterSpacing:1}}>
          min ◎{MIN_BUY_SOL} SOL to qualify as last buyer
        </div>
      </section>

      {/* ── LIVE SECTION — two col on desktop, stacked on mobile ── */}
      <section style={{padding:isMobile?"0 16px 48px":"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 340px",gap:isMobile?20:28,alignItems:"start"}}>

          {/* LEFT: stats + leader */}
          <div>
            {/* Stats grid */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:1,border:"1px solid var(--border)",borderRadius:4,overflow:"hidden",marginBottom:isMobile?16:20}}>
              {[
                {label:"CURRENT LEADER", value:lastBuyer?short(lastBuyer):"no leader yet", red:!!lastBuyer, full:true},
                {label:"POT",            value:"◎ "+fmtSOL(currentPot)},
                {label:"TOTAL PAID",     value:"◎ "+fmtSOL(totalPaid)},
                {label:"WINNERS",        value:totalRounds.toString()},
                {label:"BIGGEST WIN",    value:"◎ "+fmtSOL(biggestWin)},
              ].map((s,i)=>(
                <div key={s.label} style={{padding:isMobile?"14px":"20px 24px",background:"var(--bg2)",borderRight:"1px solid var(--border)",borderBottom:"1px solid var(--border)",gridColumn:s.full?"1 / -1":"auto"}}>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,fontWeight:700,letterSpacing:4,color:"var(--greyDim)",marginBottom:6}}>{s.label}</div>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:s.full?isMobile?14:16:isMobile?14:18,color:s.red?"var(--green)":"var(--white)",fontWeight:700,wordBreak:"break-all"}}>{s.value}</div>
                  {s.full && stats?.lastBuyAt && (
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"var(--greyDim)",marginTop:4}}>bought {timeAgo(stats.lastBuyAt.toMillis())}</div>
                  )}
                </div>
              ))}
            </div>

            {/* How it works */}
            <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16}}>
              <div style={{flex:1,height:1,background:"var(--border)"}}/>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,fontWeight:700,letterSpacing:4,color:"var(--grey)",whiteSpace:"nowrap"}}>HOW IT WORKS</div>
              <div style={{flex:1,height:1,background:"var(--border)"}}/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:1,border:"1px solid var(--border)",borderRadius:4,overflow:"hidden"}}>
              {[
                {n:"01",title:"BUY",     desc:"Buy ◎"+MIN_BUY_SOL+"+ to become leader"},
                {n:"02",title:"LEAD",    desc:"Timer resets on every qualifying buy"},
                {n:"03",title:"SURVIVE", desc:"Nobody buys before zero — you win"},
                {n:"04",title:"WIN",     desc:"SOL sent on-chain instantly"},
              ].map(s=>(
                <div key={s.n} style={{padding:isMobile?"14px":"20px 16px",background:"var(--bg2)",borderRight:"1px solid var(--border)"}}>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:isMobile?20:28,color:"rgba(255,32,32,0.15)",fontWeight:700,lineHeight:1,marginBottom:8}}>{s.n}</div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:12,fontWeight:700,color:"var(--white)",letterSpacing:1,marginBottom:6}}>{s.title}</div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)",lineHeight:1.5}}>{s.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT: live feed */}
          <div style={{position:isMobile?"static":"sticky",top:80}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
              <div style={{flex:1,height:1,background:"var(--border)"}}/>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,fontWeight:700,letterSpacing:4,color:"var(--grey)",whiteSpace:"nowrap"}}>LIVE ACTIVITY</div>
              <div style={{flex:1,height:1,background:"var(--border)"}}/>
            </div>
            <BuyFeed buys={buys}/>

            {lastBuyer&&(
              <div style={{marginTop:12,padding:"14px 16px",border:"1px solid var(--green)",borderRadius:4,background:"rgba(57,255,20,0.04)",animation:"pulse-green 3s ease-in-out infinite"}}>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,fontWeight:700,letterSpacing:4,color:"var(--green)",marginBottom:8}}>★ LEADING NOW</div>
                <div style={{fontFamily:"'Space Mono',monospace",fontSize:13,color:"var(--white)",wordBreak:"break-all"}}>{short(lastBuyer)}</div>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--greyDim)",marginTop:6}}>
                  wins ◎{fmtSOL(currentPot)} if nobody buys before timer ends
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── RECENT WINNERS ── */}
      {winners.length > 0 && (
        <section style={{padding:isMobile?"0 16px 48px":"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
          <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16}}>
            <div style={{flex:1,height:1,background:"var(--border)"}}/>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,fontWeight:700,letterSpacing:4,color:"var(--grey)",whiteSpace:"nowrap"}}>RECENT WINNERS</div>
            <div style={{flex:1,height:1,background:"var(--border)"}}/>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:1,border:"1px solid var(--border)",borderRadius:4,overflow:"hidden"}}>
            {winners.map((w,i)=>(
              <div key={w.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:isMobile?"12px 14px":"14px 20px",background:i%2===0?"var(--bg2)":"var(--bg3)",flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:10,color:"var(--greyDim)",minWidth:24}}>#{w.round||i+1}</div>
                  <div>
                    <div style={{fontFamily:"'Space Mono',monospace",fontSize:12,color:"var(--white)"}}>{short(w.winner)}</div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"var(--grey)",marginTop:2}}>{w.timestamp?timeAgo(w.timestamp.toMillis()):""}</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:14}}>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:13,color:"var(--green)",fontWeight:700}}>◎ {fmtSOL(w.amount)}</div>
                  {w.txSig&&(<a href={"https://solscan.io/tx/"+w.txSig} target="_blank" rel="noreferrer" style={{fontFamily:"'Inter',sans-serif",fontSize:10,letterSpacing:2,color:"var(--greyDim)",textDecoration:"underline"}}>TX ↗</a>)}
                </div>
              </div>
            ))}
          </div>
          <div style={{textAlign:"center",marginTop:14}}>
            <button onClick={()=>navigate("history")} className="btn-outline">VIEW ALL WINNERS</button>
          </div>
        </section>
      )}

      {/* ── CA ── */}
      <section style={{padding:isMobile?"0 16px 48px":"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
        <div style={{border:"1px solid var(--border)",borderRadius:4,padding:isMobile?"16px":"24px",background:"var(--bg2)"}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,fontWeight:700,letterSpacing:4,color:"var(--grey)",marginBottom:10}}>CONTRACT ADDRESS</div>
          <div style={{fontFamily:"'Space Mono',monospace",fontSize:isMobile?9:12,color:isLive?"var(--white)":"var(--grey)",wordBreak:"break-all",lineHeight:1.7,marginBottom:14,fontStyle:isLive?"normal":"italic"}}>
            {isLive?TOKEN_CA:"— contract address at launch —"}
          </div>
          <div style={{display:"flex",flexDirection:isMobile?"column":"row",gap:10}}>
            {isLive&&(<button onClick={copyCA} className="btn-green" style={{fontSize:11,padding:"10px 20px",width:isMobile?"100%":"auto"}}>{copiedCA?"COPIED ✓":"COPY CA"}</button>)}
            <a href={X_URL} target="_blank" rel="noreferrer" style={{width:isMobile?"100%":"auto"}}>
              <button className="btn-outline" style={{width:isMobile?"100%":"auto"}}>𝕏 TWITTER</button>
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{borderTop:"1px solid var(--border)",padding:isMobile?"16px":"20px 28px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div style={{fontFamily:"'Space Mono',monospace",fontSize:10,color:"var(--greyDim)"}}>LAST BUYER WINS — ON SOLANA</div>
        {!isMobile&&<div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--greyDim)",fontStyle:"italic"}}>The clock resets. The pot grows. One wallet wins.</div>}
        <a href={X_URL} target="_blank" rel="noreferrer" style={{fontFamily:"'Inter',sans-serif",fontSize:11,letterSpacing:3,color:"var(--greyDim)",textDecoration:"none"}}>𝕏</a>
      </footer>
    </div>
  );
}