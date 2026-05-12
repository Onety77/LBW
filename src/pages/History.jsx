import { useState, useEffect } from "react";
import { collection, query, orderBy, limit, getDocs, startAfter } from "firebase/firestore";
import { db } from "../firebase";

const short   = (a) => a ? a.slice(0,4)+"..."+a.slice(-4) : "—";
const fmtSOL  = (n) => (!n && n !== 0) ? "0.0000" : n.toFixed(4);
const fmtDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts.toMillis());
  return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})
    + " " + d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"});
};

export default function History({ navigate }) {
  const [winners,  setWinners]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [hasMore,  setHasMore]  = useState(false);
  const [lastDoc,  setLastDoc]  = useState(null);

  const PAGE = 20;

  const load = async (after = null) => {
    setLoading(true);
    try {
      let q = query(
        collection(db,"lbw_history"),
        orderBy("timestamp","desc"),
        limit(PAGE+1)
      );
      if (after) q = query(
        collection(db,"lbw_history"),
        orderBy("timestamp","desc"),
        startAfter(after),
        limit(PAGE+1)
      );
      const snap = await getDocs(q);
      const docs = snap.docs.slice(0,PAGE).map(d=>({id:d.id,...d.data()}));
      setHasMore(snap.docs.length > PAGE);
      if (after) {
        setWinners(p => [...p,...docs]);
        setLastDoc(snap.docs[snap.docs.length-2] || null);
      } else {
        setWinners(docs);
        setLastDoc(snap.docs[PAGE-1] || null);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(()=>{ load(); },[]);

  return (
    <div className="page" style={{minHeight:"100vh"}}>

      {/* Header */}
      <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 28px",borderBottom:"1px solid var(--border)",background:"var(--bg)",position:"sticky",top:0,zIndex:100}}>
        <button onClick={()=>navigate("home")} style={{display:"flex",alignItems:"center",gap:14,background:"none",border:"none",cursor:"pointer",padding:0}}>
          <img src="/logo.png" alt="LBW" style={{width:32,height:32,borderRadius:4,objectFit:"cover"}}/>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:"0.1em",color:"var(--white)"}}>LAST BUYER WINS</div>
        </button>
        <button onClick={()=>navigate("home")} className="btn-outline" style={{fontSize:11}}>← BACK</button>
      </header>

      <div style={{maxWidth:"var(--max-w)",margin:"0 auto",padding:"48px 24px 80px"}}>

        {/* Title */}
        <div style={{marginBottom:40}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,letterSpacing:4,color:"var(--grey)",marginBottom:12}}>ON-CHAIN RECORD</div>
          <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"clamp(40px,8vw,80px)",letterSpacing:"0.06em",color:"var(--white)",lineHeight:1}}>
            WINNERS<br/>HISTORY
          </h1>
        </div>

        {/* Table */}
        {loading && winners.length===0 ? (
          <div style={{textAlign:"center",padding:"80px"}}>
            <div style={{fontFamily:"'Space Mono',monospace",fontSize:12,color:"var(--grey)",letterSpacing:3}}>LOADING...</div>
          </div>
        ) : winners.length===0 ? (
          <div style={{textAlign:"center",padding:"80px",border:"1px solid var(--border)",borderRadius:4}}>
            <div style={{fontFamily:"'Space Mono',monospace",fontSize:40,color:"var(--greyDim)",marginBottom:20}}>◎</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:13,color:"var(--grey)",letterSpacing:3}}>NO WINNERS YET</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:12,color:"var(--greyDim)",marginTop:8}}>Be the first.</div>
          </div>
        ) : (
          <>
            {/* Column headers */}
            <div style={{
              display:"grid",
              gridTemplateColumns:"60px 1fr 1fr 100px 80px",
              gap:16,
              padding:"10px 24px",
              borderBottom:"1px solid var(--border)",
              fontFamily:"'Inter',sans-serif",
              fontSize:10,fontWeight:700,letterSpacing:4,
              color:"var(--grey)",
            }}>
              <div>#</div>
              <div>WINNER WALLET</div>
              <div>DATE</div>
              <div style={{textAlign:"right"}}>AMOUNT</div>
              <div style={{textAlign:"right"}}>TX</div>
            </div>

            <div style={{border:"1px solid var(--border)",borderTop:"none",borderRadius:"0 0 4px 4px",overflow:"hidden"}}>
              {winners.map((w,i)=>(
                <div key={w.id} style={{
                  display:"grid",
                  gridTemplateColumns:"60px 1fr 1fr 100px 80px",
                  gap:16,
                  padding:"16px 24px",
                  alignItems:"center",
                  background: i%2===0?"var(--bg2)":"var(--bg3)",
                  borderBottom:"1px solid var(--border)",
                  animation:"slide-up 0.4s ease "+(i*0.03)+"s both",
                }}>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:12,color:"var(--grey)"}}>
                    {w.round||i+1}
                  </div>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:12,color:"var(--white)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {short(w.winner)}
                  </div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"var(--grey)"}}>
                    {fmtDate(w.timestamp)}
                  </div>
                  <div style={{fontFamily:"'Space Mono',monospace",fontSize:14,color:"var(--red)",fontWeight:700,textAlign:"right"}}>
                    ◎ {fmtSOL(w.amount)}
                  </div>
                  <div style={{textAlign:"right"}}>
                    {w.txSig ? (
                      <a href={"https://solscan.io/tx/"+w.txSig} target="_blank" rel="noreferrer"
                        style={{fontFamily:"'Inter',sans-serif",fontSize:10,letterSpacing:2,color:"var(--grey)",textDecoration:"underline"}}>
                        VIEW ↗
                      </a>
                    ) : <span style={{color:"var(--greyDim)"}}>—</span>}
                  </div>
                </div>
              ))}
            </div>

            {hasMore && (
              <div style={{textAlign:"center",marginTop:20}}>
                <button onClick={()=>load(lastDoc)} className="btn-outline" disabled={loading}>
                  {loading?"LOADING...":"LOAD MORE"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
