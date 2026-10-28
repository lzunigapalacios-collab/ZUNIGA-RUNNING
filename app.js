(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "zuniga-running-activities-v1";
  const state = { active:false, paused:false, watchId:null, startedAt:0, segmentStartedAt:0, elapsedBeforeSegment:0, elapsedMs:0, distance:0, points:[], lastPoint:null, lastSplitKm:0, splits:[], wakeLock:null, activityType:"Carrera" };
  let activities = loadActivities();
  let ticker = null;

  function loadActivities(){ try { const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]"); return Array.isArray(data)?data:[]; } catch { return []; } }
  function saveActivities(){ try { localStorage.setItem(STORAGE_KEY,JSON.stringify(activities)); } catch { alert("No se pudieron guardar los datos. Revisa el espacio disponible del navegador."); } }
  function fmtTime(ms){ const s=Math.max(0,Math.floor(ms/1000)); return [Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(n=>String(n).padStart(2,"0")).join(":"); }
  function fmtShortTime(ms){const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0");}
  function fmtPace(ms,km){if(!km||km<0.03)return "--:--";const sec=Math.round(ms/1000/km);if(!Number.isFinite(sec)||sec>3600)return "--:--";return Math.floor(sec/60)+":"+String(sec%60).padStart(2,"0");}
  function fmtDate(iso){return new Date(iso).toLocaleString("es-MX",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});}
  function haversine(a,b){const R=6371000,rad=x=>x*Math.PI/180;const dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon);const x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
  function setGps(message,kind=""){ $("gpsStatus").textContent=message;$("gpsDot").className="dot"+(kind?" "+kind:""); }
  function elapsedNow(){return state.elapsedBeforeSegment+(state.active&&!state.paused?Date.now()-state.segmentStartedAt:0);}
  function renderMetrics(){
    state.elapsedMs=elapsedNow();
    $("distance").innerHTML=state.distance.toFixed(2)+' <span>km</span>';
    $("duration").textContent=fmtTime(state.elapsedMs);
    $("pace").textContent=fmtPace(state.elapsedMs,state.distance);
    $("calories").textContent=String(Math.round(state.distance*60));
    $("activityLabel").textContent=!state.active?"Sin iniciar":state.paused?"Pausado":"En curso";
  }
  function start(){
    if(!("geolocation" in navigator)){setGps("GPS no disponible","bad");alert("Este navegador no permite acceder al GPS.");return;}
    if(!window.isSecureContext){alert("Por seguridad, el GPS necesita abrir la app desde una dirección HTTPS (GitHub Pages), no como archivo local.");return;}
    state.active=true;state.paused=false;state.startedAt=Date.now();state.segmentStartedAt=Date.now();state.elapsedBeforeSegment=0;state.elapsedMs=0;state.distance=0;state.points=[];state.lastPoint=null;state.lastSplitKm=0;state.splits=[];
    $("startBtn").hidden=true;$("activeActions").hidden=false;$("pauseBtn").textContent="Ⅱ Pausar";
    setGps("Buscando señal…");renderMetrics();ticker=setInterval(renderMetrics,500);
    state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
    if("wakeLock" in navigator)navigator.wakeLock.request("screen").then(lock=>state.wakeLock=lock).catch(()=>{});
  }
  function onPosition(position){
    if(!state.active||state.paused)return;
    const c=position.coords;
    if(c.accuracy>60){setGps("Señal débil ("+Math.round(c.accuracy)+" m)","bad");return;}
    const point={lat:c.latitude,lon:c.longitude,accuracy:c.accuracy,time:position.timestamp||Date.now()};
    if(state.lastPoint){
      const d=haversine(state.lastPoint,point);const seconds=Math.max((point.time-state.lastPoint.time)/1000,0.1);const speed=d/seconds;
      // Reduce el ruido de GPS: descarta saltos diminutos o físicamente improbables.
      if(d<2.5)return;
      if(speed>9.5){setGps("Filtrando salto GPS","bad");return;}
      state.distance+=d/1000;
      const newSplit=Math.floor(state.distance);
      if(newSplit>state.lastSplitKm){state.splits.push({km:newSplit,elapsedMs:elapsedNow()});state.lastSplitKm=newSplit;}
    }
    state.lastPoint=point;state.points.push([point.lat,point.lon]);
    if(state.points.length>3500)state.points=state.points.filter((_,i)=>i%2===0);
    setGps("GPS conectado","good");renderMetrics();renderRoute();
  }
  function onGpsError(error){
    const messages={1:"Permiso de ubicación denegado",2:"No se encuentra señal GPS",3:"GPS tardó demasiado"};
    setGps(messages[error.code]||"Error de GPS","bad");
    if(error.code===1){alert("Activa el permiso de ubicación para tu navegador y vuelve a iniciar el entrenamiento.");}
  }
  function pauseToggle(){
    if(!state.active)return;
    if(!state.paused){state.elapsedBeforeSegment=elapsedNow();state.paused=true;if(state.watchId!==null)navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$("pauseBtn").textContent="▶ Reanudar";setGps("Entrenamiento pausado");}
    else{state.paused=false;state.segmentStartedAt=Date.now();setGps("Buscando señal…");state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});$("pauseBtn").textContent="Ⅱ Pausar";}
    renderMetrics();
  }
  function stopGps(){if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;}if(ticker){clearInterval(ticker);ticker=null;}if(state.wakeLock){state.wakeLock.release().catch(()=>{});state.wakeLock=null;}}
  function finish(){
    if(!state.active)return;
    state.elapsedMs=elapsedNow();stopGps();state.active=false;state.paused=false;
    $("startBtn").hidden=false;$("activeActions").hidden=true;setGps("GPS listo");
    if(state.distance>=0.005&&state.elapsedMs>0){
      const item={id:Date.now(),date:new Date().toISOString(),distance:Number(state.distance.toFixed(4)),durationMs:Math.round(state.elapsedMs),pace:fmtPace(state.elapsedMs,state.distance),calories:Math.round(state.distance*60),points:state.points.length,splits:state.splits};
      activities.unshift(item);activities=activities.slice(0,300);saveActivities();renderHistory();renderStats();
      $("finalDistance").textContent=item.distance.toFixed(2)+" km";$("finalDuration").textContent=fmtShortTime(item.durationMs);$("finalPace").textContent=item.pace;$("finishDialog").showModal();
    }else{alert("La actividad no se guardó porque todavía no hay distancia GPS suficiente. Intenta salir a un lugar abierto y espera a que el GPS conecte.");}
    renderMetrics();
  }
  function renderRoute(){
    const pts=state.points;if(!pts.length){$("routePlaceholder").setAttribute("opacity","1");return;}
    $("routePlaceholder").setAttribute("opacity","0");
    const lats=pts.map(p=>p[0]),lons=pts.map(p=>p[1]);let minLat=Math.min(...lats),maxLat=Math.max(...lats),minLon=Math.min(...lons),maxLon=Math.max(...lons);
    if(maxLat-minLat<0.00004){minLat-=0.00002;maxLat+=0.00002;}if(maxLon-minLon<0.00004){minLon-=0.00002;maxLon+=0.00002;}
    const pad=12,w=320,h=110,latMid=(minLat+maxLat)/2,cos=Math.cos(latMid*Math.PI/180)||1;
    let coords=pts.map(p=>{const x=pad+((p[1]-minLon)*cos)/((maxLon-minLon)*cos||1)*(w-pad*2);const y=h-pad-((p[0]-minLat)/(maxLat-minLat||1))*(h-pad*2);return [x,y];});
    $("routePath").setAttribute("d",coords.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" "));
    const a=coords[0],b=coords[coords.length-1];$("routeStart").setAttribute("cx",a[0]);$("routeStart").setAttribute("cy",a[1]);$("routeStart").setAttribute("opacity","1");$("routeEnd").setAttribute("cx",b[0]);$("routeEnd").setAttribute("cy",b[1]);$("routeEnd").setAttribute("opacity","1");
    $("pointsLabel").textContent=pts.length+" puntos GPS";
  }
  function renderStats(){
    const totalKm=activities.reduce((n,a)=>n+(Number(a.distance)||0),0),totalMs=activities.reduce((n,a)=>n+(Number(a.durationMs)||0),0);
    $("totalDistance").innerHTML=totalKm.toFixed(2)+' <i>km</i>';
    const mins=Math.floor(totalMs/60000);$("totalTime").textContent=Math.floor(mins/60)+" h "+String(mins%60).padStart(2,"0")+" min";
    $("totalActivities").textContent=String(activities.length);
    const good=activities.filter(a=>a.distance>0&&a.durationMs>0);good.sort((a,b)=>a.durationMs/a.distance-b.durationMs/b.distance);
    $("bestPace").innerHTML=(good[0]?fmtPace(good[0].durationMs,good[0].distance):"--:--")+' <i>/km</i>';
  }
  function renderHistory(){
    const list=$("historyList");list.replaceChildren();$("emptyHistory").hidden=activities.length>0;
    activities.forEach(a=>{
      const article=document.createElement("article");article.className="history-item";
      const icon=document.createElement("div");icon.className="history-icon";icon.textContent="↗";
      const main=document.createElement("div");main.className="history-main";
      const title=document.createElement("strong");title.textContent="Carrera o caminata";
      const meta=document.createElement("small");meta.textContent=fmtDate(a.date)+" · "+fmtShortTime(a.durationMs)+" · "+a.pace+" min/km";
      const distance=document.createElement("div");distance.className="history-distance";distance.textContent=Number(a.distance).toFixed(2)+" km";
      const sub=document.createElement("small");sub.textContent="≈ "+(a.calories||0)+" kcal";distance.appendChild(sub);
      main.append(title,meta);article.append(icon,main,distance);list.appendChild(article);
    });
  }
  $("startBtn").addEventListener("click",start);$("pauseBtn").addEventListener("click",pauseToggle);$("finishBtn").addEventListener("click",finish);
  $("closeDialog").addEventListener("click",()=>$("finishDialog").close());
  $("exportBtn").addEventListener("click",()=>{
    if(!activities.length){alert("Todavía no tienes actividades para exportar.");return;}
    const rows=[["fecha","distancia_km","duracion_segundos","ritmo_min_km","calorias_estimadas","puntos_gps"],...activities.map(a=>[a.date,a.distance,Math.round(a.durationMs/1000),a.pace,a.calories,a.points])];
    const csv=rows.map(row=>row.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(",")).join("\r\n");
    const url=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"}));const link=document.createElement("a");link.href=url;link.download="zuniga-running-historial.csv";link.click();URL.revokeObjectURL(url);
  });
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&state.active&&!state.paused&&state.watchId===null){state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});}});
  renderMetrics();renderStats();renderHistory();
})();