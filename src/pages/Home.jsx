import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot, collection, query, orderBy, limit } from "firebase/firestore";
import { db } from "../firebase";

// ── CONFIG — fill before deploy ────────────────────────────────────────────
const TOKEN_CA      = "A8xTARmK3XwytJ5WbKcBcFCAoEBPxK51jj4jrnGapump";
const X_URL         = "https://x.com/REPLACE";
const SITE_URL      = "https://lastbuyerwins.xyz";
const TIMER_DEFAULT = 1 * 60 * 1000; // 10 minutes
const MIN_BUY_SOL   = 0.1;

// ── Helpers ─────────────────────────────────────────────────────────────────
const short   = (a) => a ? a.slice(0,4)+"..."+a.slice(-4) : "—";
const fmtSOL  = (n) => (!n && n !== 0) ? "0.0000" : n.toFixed(4);
const fmtTime = (ms) => {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms/1000);
  const m = Math.floor(total/60);
  const s = total%60;
  return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
};
const timeAgo = (ms) => {
  const s = Math.floor((Date.now()-ms)/1000);
  if (s < 60)    return s+"s ago";
  if (s < 3600)  return Math.floor(s/60)+"m ago";
  if (s < 86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
};

// ── Big Countdown Display ────────────────────────────────────────────────────
function CountdownDisplay({ ms, urgent }) {
  const str = fmtTime(ms);
  return (
    <div style={{
      fontFamily:"'Space Mono',monospace",
      fontSize:"clamp(72px,18vw,180px)",
      fontWeight:700,
      lineHeight:1,
      color: urgent ? "var(--red)" : "var(--white)",
      letterSpacing:"-0.02em",
      transition:"color 0.3s ease",
      animation: urgent ? "urgent-shake 0.5s ease infinite" : "none",
      textShadow: urgent
        ? "0 0 40px rgba(255,32,32,0.6), 0 0 80px rgba(255,32,32,0.3)"
        : "none",
    }}>
      {str}
    </div>
  );
}

// ── Live ticker bar ──────────────────────────────────────────────────────────
function TickerBar({ stats }) {
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
    <div style={{
      borderTop:"1px solid var(--border)",
      borderBottom:"1px solid var(--border)",
      overflow:"hidden",
      padding:"10px 0",
      background:"var(--bg2)",
    }}>
      <div style={{
        display:"flex",
        gap:48,
        animation:"ticker-left 20s linear infinite",
        whiteSpace:"nowrap",
        width:"max-content",
      }}>
        {items.map((item,i)=>(
          <span key={i} style={{
            fontFamily:"'Space Mono',monospace",
            fontSize:11,
            color:"var(--grey)",
            letterSpacing:2,
          }}>
            <span style={{color:"var(--red)",marginRight:16}}>▶</span>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Home({ navigate }) {
  const [stats,     setStats]     = useState(null);
  const [winners,   setWinners]   = useState([]);
  const [countdown, setCountdown] = useState(TIMER_DEFAULT);
  const [copiedCA,  setCopiedCA]  = useState(false);
  const [menuOpen,  setMenuOpen]  = useState(false);
  const winAtRef = useRef(null);
  const isLive   = TOKEN_CA !== "PASTE_TOKEN_CA_HERE";

  // Firestore: global stats
  useEffect(()=>{
    return onSnapshot(doc(db,"lbw_stats","global"), snap=>{
      if (!snap.exists()) return;
      const d = snap.data();
      setStats(d);
      if (d.nextWinAt) {
        winAtRef.current = d.nextWinAt.toMillis();
        setCountdown(Math.max(d.nextWinAt.toMillis()-Date.now(),0));
      }
    });
  },[]);

  // Firestore: recent winners
  useEffect(()=>{
    const q = query(
      collection(db,"lbw_history"),
      orderBy("timestamp","desc"),
      limit(5)
    );
    return onSnapshot(q, snap=>
      setWinners(snap.docs.map(d=>({id:d.id,...d.data()})))
    );
  },[]);

  // Countdown tick
  useEffect(()=>{
    const id = setInterval(()=>{
      if (winAtRef.current) {
        const rem = winAtRef.current-Date.now();
        setCountdown(rem>0?rem:0);
      }
    },500);
    return ()=>clearInterval(id);
  },[]);

  const copyCA = () => {
    if (!isLive) return;
    navigator.clipboard.writeText(TOKEN_CA);
    setCopiedCA(true);
    setTimeout(()=>setCopiedCA(false),2200);
  };

  const urgent      = countdown < 60000 && countdown > 0;
  const isWaiting   = countdown === 0;
  const lastBuyer   = stats?.lastBuyer;
  const lastBuyerName= stats?.lastBuyerName;
  const currentPot  = stats?.currentPotSOL ?? null;
  const totalPaid   = stats?.totalPaid ?? 0;
  const totalRounds = stats?.totalRounds ?? 0;
  const biggestWin  = stats?.biggestWin ?? 0;

  return (
    <div className="page" style={{minHeight:"100vh",display:"flex",flexDirection:"column"}}>

      {/* ── HEADER ── */}
      <header style={{
        display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"16px 28px",
        borderBottom:"1px solid var(--border)",
        background:"var(--bg)",
        position:"fixed",top:0,left:0,right:0,zIndex:100,
      }}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <img src="/logo.png" alt="LBW" style={{width:32,height:32,borderRadius:4,objectFit:"cover"}}/>
          <div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:"0.1em",color:"var(--white)"}}>LAST BUYER WINS</div>
            <div style={{fontFamily:"'Space Mono',monospace",fontSize:8,color:"var(--grey)",letterSpacing:3,marginTop:-2}}>ON SOLANA</div>
          </div>
        </div>

        {/* Desktop nav */}
        <nav style={{display:"flex",alignItems:"center",gap:32}} className="hide-mobile">
          {[["HOME",()=>navigate("home")],["HISTORY",()=>navigate("history")]].map(([label,fn])=>(
            <button key={label} onClick={fn} style={{background:"none",border:"none",cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:12,fontWeight:600,letterSpacing:3,color:"var(--grey)",transition:"color 0.2s"}}
              onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
              onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
            >{label}</button>
          ))}
          <a href={X_URL} target="_blank" rel="noreferrer" style={{fontFamily:"'Inter',sans-serif",fontSize:12,fontWeight:600,letterSpacing:3,color:"var(--grey)",transition:"color 0.2s",textDecoration:"none"}}
            onMouseEnter={e=>e.currentTarget.style.color="var(--white)"}
            onMouseLeave={e=>e.currentTarget.style.color="var(--grey)"}
          >𝕏</a>
        </nav>

        {/* Mobile menu */}
        <button onClick={()=>setMenuOpen(o=>!o)} className="hide-desktop" style={{background:"none",border:"1px solid var(--border)",borderRadius:4,cursor:"pointer",color:"var(--grey)",padding:"6px 12px",fontSize:16,lineHeight:1}}>
          {menuOpen?"✕":"☰"}
        </button>
      </header>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div style={{position:"fixed",top:65,left:0,right:0,background:"var(--bg2)",borderBottom:"1px solid var(--border)",zIndex:99,padding:"12px 28px 20px"}}>
          {[["HOME",()=>{navigate("home");setMenuOpen(false);}],["HISTORY",()=>{navigate("history");setMenuOpen(false);}]].map(([label,fn])=>(
            <button key={label} onClick={fn} style={{display:"block",width:"100%",background:"none",border:"none",cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:600,letterSpacing:3,color:"var(--grey)",textAlign:"left",padding:"12px 0",borderBottom:"1px solid var(--border)"}}>
              {label}
            </button>
          ))}
          <a href={X_URL} target="_blank" rel="noreferrer" style={{display:"block",marginTop:12,fontFamily:"'Inter',sans-serif",fontSize:13,color:"var(--grey)",textDecoration:"none",letterSpacing:2}}>𝕏 TWITTER</a>
        </div>
      )}

      {/* ── TICKER ── */}
      <div style={{marginTop:65}}>
        <TickerBar stats={stats}/>
      </div>

      {/* ── HERO: THE COUNTDOWN ── */}
      <section style={{
        flex:1,
        display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",
        padding:"60px 24px",
        position:"relative",
        minHeight:"calc(100vh - 65px)",
        overflow:"hidden",
      }}>
        {/* Background glow */}
        <div style={{
          position:"absolute",
          width:600,height:600,
          borderRadius:"50%",
          background:"radial-gradient(circle, rgba(255,32,32,0.06) 0%, transparent 70%)",
          pointerEvents:"none",
          animation: urgent ? "pulse-red 1s ease-in-out infinite" : "none",
        }}/>

        {/* Status line */}
        <div style={{
          fontFamily:"'Space Mono',monospace",
          fontSize:11,letterSpacing:4,
          color: urgent ? "var(--red)" : "var(--grey)",
          marginBottom:24,
          animation: urgent ? "blink 1s ease infinite" : "none",
        }}>
          {isWaiting ? "⏳ PROCESSING..." : urgent ? "⚠ FINAL COUNTDOWN" : "● LIVE"}
        </div>

        {/* Big countdown */}
        <CountdownDisplay ms={countdown} urgent={urgent}/>

        {/* Label */}
        <div style={{
          fontFamily:"'Inter',sans-serif",
          fontSize:12,fontWeight:600,letterSpacing:6,
          color:"var(--grey)",
          marginTop:16,marginBottom:48,
          textTransform:"uppercase",
        }}>
          {isWaiting ? "determining winner..." : "until next winner"}
        </div>

        {/* Pot */}
        <div style={{
          textAlign:"center",marginBottom:40,
          padding:"20px 48px",
          border:"1px solid "+(urgent?"var(--red)":"var(--border)"),
          borderRadius:4,
          background: urgent ? "rgba(255,32,32,0.05)" : "var(--card)",
          transition:"all 0.3s",
          animation: urgent ? "pulse-red 1.5s ease-in-out infinite" : "none",
        }}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,fontWeight:600,letterSpacing:4,color:"var(--grey)",marginBottom:8}}>CURRENT POT</div>
          <div style={{fontFamily:"'Space Mono',monospace",fontSize:"clamp(28px,6vw,48px)",fontWeight:700,color:"var(--white)"}}>
            ◎ {fmtSOL(currentPot)}
          </div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)",marginTop:6}}>
            goes to the last qualifying buyer
          </div>
        </div>

        {/* CTA */}
        <div style={{display:"flex",gap:12,flexWrap:"wrap",justifyContent:"center"}}>
          <a href={"https://pump.fun/coin/"+TOKEN_CA} target="_blank" rel="noreferrer">
            <button className="btn-red" style={{fontSize:14,padding:"14px 36px"}}>
              BUY NOW ↗
            </button>
          </a>
          <button onClick={()=>navigate("history")} className="btn-outline">
            WINNERS HISTORY
          </button>
        </div>

        {/* Min buy notice */}
        <div style={{
          marginTop:24,
          fontFamily:"'Space Mono',monospace",
          fontSize:11,color:"var(--grey)",letterSpacing:1,
        }}>
          min ◎{MIN_BUY_SOL} SOL to qualify as last buyer
        </div>
      </section>

      {/* ── CURRENT LEADER ── */}
      <section style={{padding:"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
        <div style={{
          display:"grid",
          gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",
          gap:1,
          border:"1px solid var(--border)",
          borderRadius:4,
          overflow:"hidden",
        }}>

          {/* Leader box */}
          <div style={{
            padding:"28px",
            background:"var(--bg2)",
            borderRight:"1px solid var(--border)",
          }}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",marginBottom:12}}>CURRENT LEADER</div>
            {lastBuyer ? (
              <>
                <div style={{fontFamily:"'Space Mono',monospace",fontSize:16,color:"var(--red)",marginBottom:6,wordBreak:"break-all"}}>
                  {lastBuyerName || short(lastBuyer)}
                </div>
                <div style={{fontFamily:"'Space Mono',monospace",fontSize:11,color:"var(--grey)",wordBreak:"break-all"}}>
                  {short(lastBuyer)}
                </div>
                {stats?.lastBuyAt && (
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)",marginTop:8}}>
                    bought {timeAgo(stats.lastBuyAt.toMillis())}
                  </div>
                )}
              </>
            ) : (
              <div style={{fontFamily:"'Space Mono',monospace",fontSize:14,color:"var(--grey)"}}>
                no leader yet
              </div>
            )}
          </div>

          {/* Stats boxes */}
          {[
            {label:"POT",       value:"◎ "+fmtSOL(currentPot)},
            {label:"TOTAL PAID",value:"◎ "+fmtSOL(totalPaid)},
            {label:"WINNERS",   value:totalRounds.toString()},
            {label:"BIGGEST WIN",value:"◎ "+fmtSOL(biggestWin)},
          ].map(s=>(
            <div key={s.label} style={{padding:"28px",background:"var(--bg2)",borderRight:"1px solid var(--border)"}}>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",marginBottom:12}}>{s.label}</div>
              <div style={{fontFamily:"'Space Mono',monospace",fontSize:18,color:"var(--white)",fontWeight:700}}>{s.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section style={{padding:"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
        <div style={{display:"flex",alignItems:"center",gap:20,marginBottom:32}}>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",whiteSpace:"nowrap"}}>HOW IT WORKS</div>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:1,border:"1px solid var(--border)",borderRadius:4,overflow:"hidden"}}>
          {[
            {n:"01",title:"BUY",          desc:"Buy ◎"+MIN_BUY_SOL+" or more of the token in a single transaction to become the current leader."},
            {n:"02",title:"LEAD",         desc:"The 10-minute timer resets every time a qualifying buy happens. You are now the leader."},
            {n:"03",title:"SURVIVE",      desc:"If nobody buys more than you before the timer hits zero — you win the entire pot."},
            {n:"04",title:"WIN",          desc:"The SOL accumulated from trading fees is sent directly to your wallet. On-chain. Instant."},
          ].map(s=>(
            <div key={s.n} style={{padding:"28px 24px",background:"var(--bg2)",borderRight:"1px solid var(--border)"}}>
              <div style={{fontFamily:"'Space Mono',monospace",fontSize:32,color:"rgba(255,32,32,0.15)",fontWeight:700,lineHeight:1,marginBottom:12}}>{s.n}</div>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:700,color:"var(--white)",letterSpacing:1,marginBottom:10}}>{s.title}</div>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:13,color:"var(--grey)",lineHeight:1.65}}>{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── RECENT WINNERS ── */}
      {winners.length > 0 && (
        <section style={{padding:"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
          <div style={{display:"flex",alignItems:"center",gap:20,marginBottom:24}}>
            <div style={{flex:1,height:1,background:"var(--border)"}}/>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",whiteSpace:"nowrap"}}>RECENT WINNERS</div>
            <div style={{flex:1,height:1,background:"var(--border)"}}/>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:1,border:"1px solid var(--border)",borderRadius:4,overflow:"hidden"}}>
            {winners.map((w,i)=>(
              <div key={w.id} style={{
                display:"flex",alignItems:"center",
                justifyContent:"space-between",gap:16,
                padding:"16px 24px",
                background: i%2===0 ? "var(--bg2)" : "var(--bg3)",
                flexWrap:"wrap",gap:12,
              }}>
                <div style={{display:"flex",alignItems:"center",gap:16}}>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:11,color:"var(--grey)",minWidth:28}}>#{w.round||i+1}</div>
                  <div>
                    <div style={{fontFamily:"'Space Mono',monospace",fontSize:13,color:"var(--white)"}}>{short(w.winner)}</div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)",marginTop:2}}>{w.timestamp?timeAgo(w.timestamp.toMillis()):""}</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:20}}>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:15,color:"var(--red)",fontWeight:700}}>◎ {fmtSOL(w.amount)}</div>
                  {w.txSig && (
                    <a href={"https://solscan.io/tx/"+w.txSig} target="_blank" rel="noreferrer"
                      style={{fontFamily:"'Inter',sans-serif",fontSize:10,letterSpacing:2,color:"var(--grey)",textDecoration:"underline"}}>
                      TX ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div style={{textAlign:"center",marginTop:16}}>
            <button onClick={()=>navigate("history")} className="btn-outline">VIEW ALL WINNERS</button>
          </div>
        </section>
      )}

      {/* ── CA SECTION ── */}
      <section style={{padding:"0 24px 80px",maxWidth:"var(--max-w)",margin:"0 auto",width:"100%"}}>
        <div style={{
          border:"1px solid var(--border)",
          borderRadius:4,
          padding:"24px",
          background:"var(--bg2)",
        }}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",marginBottom:12}}>CONTRACT ADDRESS</div>
          <div style={{
            fontFamily:"'Space Mono',monospace",
            fontSize:13,color: isLive ? "var(--white)" : "var(--grey)",
            wordBreak:"break-all",lineHeight:1.6,marginBottom:16,
            fontStyle: isLive ? "normal" : "italic",
          }}>
            {isLive ? TOKEN_CA : "— contract address at launch —"}
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {isLive && (
              <button onClick={copyCA} className="btn-red" style={{fontSize:11,padding:"10px 20px"}}>
                {copiedCA?"COPIED ✓":"COPY CA"}
              </button>
            )}
            <a href={X_URL} target="_blank" rel="noreferrer">
              <button className="btn-outline">𝕏 TWITTER</button>
            </a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        borderTop:"1px solid var(--border)",
        padding:"24px 28px",
        display:"flex",alignItems:"center",
        justifyContent:"space-between",
        flexWrap:"wrap",gap:12,
      }}>
        <div style={{fontFamily:"'Space Mono',monospace",fontSize:11,color:"var(--grey)"}}>
          LAST BUYER WINS — ON SOLANA
        </div>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)",fontStyle:"italic"}}>
          The clock resets. The pot grows. One wallet wins.
        </div>
        <a href={X_URL} target="_blank" rel="noreferrer"
          style={{fontFamily:"'Inter',sans-serif",fontSize:11,letterSpacing:3,color:"var(--grey)",textDecoration:"none"}}>
          𝕏
        </a>
      </footer>

    </div>
  );
}
