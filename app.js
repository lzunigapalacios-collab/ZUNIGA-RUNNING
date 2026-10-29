(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "zuniga-running-activities-v2";
  const state = {active:false,paused:false,watchId:null,startedAt:0,segmentStartedAt:0,elapsedBeforeSegment:0,elapsedMs:0,distance:0,points:[],track:[],lastPoint:null,lastSplitKm:0,splits:[],maxSpeedKmh:0,wakeLock:null};
  let activities=[],draftTimer=null,lastDraftKey="",ticker=null,liveMap=null,liveLine=null,liveStart=null,liveEnd=null,detailMap=null,detailLine=null,roadsData=null,roadsLoadPromise=null;
  
  function loadActivities(){try{const current=localStorage.getItem(STORAGE_KEY);if(current!==null){const data=JSON.parse(current);return Array.isArray(data)?data:[]}const legacy=JSON.parse(localStorage.getItem("zuniga-running-activities-v1")||"[]");const data=Array.isArray(legacy)?legacy:[];localStorage.setItem(STORAGE_KEY,JSON.stringify(data));return data;}catch{return[]}}
  function saveActivities(quiet){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(activities));return true}catch{if(!quiet)alert("No se pudieron guardar los datos: el almacenamiento del navegador está lleno. No cierres ni recargues la página; usa «Exportar datos» para respaldar tu historial antes de eliminar actividades antiguas.");return false}}

  // ===== Almacenamiento: IndexedDB (con respaldo en localStorage si el navegador no la ofrece) =====
  // Cada actividad es un registro propio (clave = id). La copia antigua de localStorage NO se borra: queda como respaldo.
  const DB_NAME="zuniga-running",DB_VERSION=1,ACTIVITIES="activities",META="meta",LEGACY_V1_KEY="zuniga-running-activities-v1",MIGRATION_KEY="migrated-from-localstorage",DRAFT_KEY="active-draft";
  const storage={mode:"local",db:null,ready:false};
  function idbOpen(){return new Promise((resolve,reject)=>{
    const request=window.indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(ACTIVITIES))db.createObjectStore(ACTIVITIES,{keyPath:"id"});if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:"key"})};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db)};
    request.onerror=()=>reject(request.error);
  })}
  // Ejecuta `work(tx)` y se resuelve solo cuando la transacción termina (datos ya escritos en disco).
  function idbTx(db,stores,mode,work){return new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,mode);let result;
    tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error("transacción cancelada"));
    try{result=work(tx)}catch(error){try{tx.abort()}catch{}reject(error)}
  })}
  function readLegacyActivities(){
    try{
      const current=localStorage.getItem(STORAGE_KEY);
      const raw=current!==null?current:localStorage.getItem(LEGACY_V1_KEY);
      if(raw===null)return{ok:true,items:[]};
      const data=JSON.parse(raw);
      return{ok:true,items:Array.isArray(data)?data:[]};
    }catch{return{ok:false,items:[]}}
  }
  // Asigna ids estables a lo antiguo (misma entrada -> mismo id), omite copias exactas y nunca pisa dos actividades distintas.
  function prepareLegacyItems(list){
    const used=new Map(),out=[];
    list.forEach((raw,index)=>{
      if(!raw||typeof raw!=="object"||Array.isArray(raw))return;
      const text=JSON.stringify(raw),item=Object.assign({},raw);
      let id=item.id;
      const valid=(typeof id==="number"&&Number.isFinite(id))||(typeof id==="string"&&id!=="");
      if(!valid){const time=Date.parse(item.date);id=Number.isFinite(time)?time:-(index+1)}
      const base=String(id);
      if(used.has(base)){
        if(used.get(base)===text)return;
        let n=2;while(used.has(base+"-"+n))n++;
        id=base+"-"+n;
      }
      item.id=id;used.set(String(id),text);out.push(item);
    });
    return out;
  }
  // Una sola transacción: copia todo y marca "migrado" solo si TODO quedó escrito; si algo falla se cancela y no cambia nada.
  function migrateLegacyActivities(db){
    return idbTx(db,[ACTIVITIES,META],"readwrite",tx=>{
      const meta=tx.objectStore(META),store=tx.objectStore(ACTIVITIES);
      const check=meta.get(MIGRATION_KEY);
      check.onsuccess=()=>{
        try{
          if(check.result)return; // ya migrado antes (también evita que reaparezca lo eliminado)
          const legacy=readLegacyActivities();
          if(!legacy.ok)return; // no se pudo leer localStorage: no se marca, se reintenta al abrir
          const items=prepareLegacyItems(legacy.items);
          items.forEach(item=>store.put(item));
          const keys=store.getAllKeys();
          keys.onsuccess=()=>{
            try{
              const present=new Set(keys.result.map(String));
              if(!items.every(item=>present.has(String(item.id)))){tx.abort();return}
              meta.put({key:MIGRATION_KEY,at:new Date().toISOString(),count:items.length});
            }catch{try{tx.abort()}catch{}}
          };
        }catch{try{tx.abort()}catch{}}
      };
    });
  }
  function sortActivities(list){return list.slice().sort((a,b)=>(Date.parse(b.date)||0)-(Date.parse(a.date)||0)||(Number(b.id)||0)-(Number(a.id)||0))}
  async function initStorage(){
    try{
      if(!window.indexedDB)throw new Error("IndexedDB no disponible");
      // Si IndexedDB se queda colgada (ocurre en algunos navegadores), tras 5 s se usa el respaldo en localStorage para no bloquear la app.
      const db=await Promise.race([idbOpen(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("IndexedDB tardó demasiado")),5000))]);
      await migrateLegacyActivities(db);
      const request=await idbTx(db,[ACTIVITIES],"readonly",tx=>tx.objectStore(ACTIVITIES).getAll());
      activities=sortActivities(request.result||[]);
      storage.db=db;storage.mode="idb";
    }catch{
      storage.db=null;storage.mode="local";activities=loadActivities();
    }
    storage.ready=true;
  }
  function buildActivityItem(o){
    return{
      id:o.id,type:o.type,date:o.date,
      distance:Number(o.distance.toFixed(4)),
      durationMs:Math.round(o.elapsedMs),
      pace:fmtPace(o.elapsedMs,o.distance),
      avgSpeedKmh:o.elapsedMs>0?Number((o.distance/(o.elapsedMs/3600000)).toFixed(2)):0,
      maxSpeedKmh:Number((o.maxSpeedKmh||0).toFixed(2)),
      calories:Math.round(o.distance*60),
      points:o.track.map(p=>[Number(p[0].toFixed(6)),Number(p[1].toFixed(6))]), // recorrido completo: solo latitud y longitud
      splits:(o.splits||[]).slice()
    };
  }
  // Actividades que todavía no se pudieron escribir: siguen en memoria y se reintentan junto con la siguiente que se guarde o al eliminar una.
  const unsaved=new Map();
  async function flushUnsaved(clearDraft){
    if(!unsaved.size)return true;
    const batch=Array.from(unsaved.values());
    let ok;
    if(storage.mode==="idb"){
      try{await idbTx(storage.db,[ACTIVITIES,META],"readwrite",tx=>{const store=tx.objectStore(ACTIVITIES);batch.forEach(a=>store.put(a));if(clearDraft)tx.objectStore(META).delete(DRAFT_KEY)});ok=true}catch{ok=false}
    }else ok=saveActivities(true);
    if(ok)batch.forEach(a=>unsaved.delete(a.id));
    return ok;
  }
  async function persistActivity(item){unsaved.set(item.id,item);return flushUnsaved(true)}
  // Agrega la actividad al historial y la guarda; solo devuelve true si quedó realmente guardada.
  async function commitActivity(item){
    const existing=activities.findIndex(a=>a.id===item.id);if(existing>=0)activities.splice(existing,1);
    activities.unshift(item);
    let stored=await persistActivity(item);
    while(!stored&&confirm("⚠️ La actividad NO se guardó: no se pudo escribir en el almacenamiento del navegador.\n\nPor ahora sigue en memoria. No cierres ni recargues esta página.\n\nAceptar = reintentar el guardado\nCancelar = conservarla en memoria y exportarla con «Exportar datos»"))stored=await persistActivity(item);
    activities=sortActivities(activities);
    renderHistory();renderStats();
    if(!stored){
      setGps("Actividad sin guardar","bad");
      alert("La actividad NO está guardada. Sigue en memoria y aparece en tu historial: usa «Exportar datos» para respaldarla antes de cerrar la página. Se volverá a intentar guardar al terminar la próxima actividad o al eliminar una.");
    }
    return stored;
  }
  // Elimina una sola actividad; si el borrado falla, la actividad NO desaparece de la lista.
  async function removeActivity(a){
    if(storage.mode==="idb"){
      if(a.id===undefined)return false;
      try{await idbTx(storage.db,[ACTIVITIES],"readwrite",tx=>{tx.objectStore(ACTIVITIES).delete(a.id)})}catch{return false}
      unsaved.delete(a.id);
      activities=activities.filter(item=>item!==a);
      flushUnsaved(false).catch(()=>{}); // aprovecha para reintentar lo que no se había podido guardar
      return true;
    }
    const previous=activities;activities=previous.filter(item=>item!==a);
    if(saveActivities(true))return true;
    activities=previous;return false;
  }
  // Autoguardado: borrador de la actividad en curso (cada ~15 s, al ocultar la página y al cerrarla).
  function saveDraft(){
    if(storage.mode!=="idb"||!state.active||state.track.length<2||state.distance<.005)return;
    const signature=state.track.length+":"+state.distance.toFixed(4);
    if(signature===lastDraftKey)return;
    lastDraftKey=signature;
    idbTx(storage.db,[META],"readwrite",tx=>{tx.objectStore(META).put({key:DRAFT_KEY,startedAt:state.startedAt,savedAt:Date.now(),type:$("activityType").value,elapsedMs:elapsedNow(),distance:state.distance,maxSpeedKmh:state.maxSpeedKmh,splits:state.splits.slice(),track:state.track.slice()})}).catch(()=>{lastDraftKey=""});
  }
  async function recoverInterruptedActivity(){
    if(storage.mode!=="idb"||state.active)return;
    let draft;
    try{const request=await idbTx(storage.db,[META],"readonly",tx=>tx.objectStore(META).get(DRAFT_KEY));draft=request.result}catch{return}
    if(!draft)return;
    const track=Array.isArray(draft.track)?draft.track:[];
    const clearDraft=()=>idbTx(storage.db,[META],"readwrite",tx=>{tx.objectStore(META).delete(DRAFT_KEY)}).catch(()=>{});
    if(!(Number(draft.distance)>=.005)||!(Number(draft.elapsedMs)>0)||track.length<2){await clearDraft();return}
    const summary=Number(draft.distance).toFixed(2)+" km, "+fmtShortTime(draft.elapsedMs);
    const save=confirm("Se encontró una actividad que se interrumpió ("+summary+").\n\n¿Guardarla en tu historial?")||!confirm("¿Descartarla definitivamente?\n\nAceptar = descartar\nCancelar = guardarla");
    if(!save){await clearDraft();return}
    await commitActivity(buildActivityItem({id:draft.startedAt,type:draft.type,date:new Date(Number(draft.savedAt)||Date.now()).toISOString(),distance:Number(draft.distance),elapsedMs:Number(draft.elapsedMs),maxSpeedKmh:Number(draft.maxSpeedKmh)||0,track,splits:Array.isArray(draft.splits)?draft.splits:[]}));
  }

  async function requestWakeLock(){
    if(!("wakeLock" in navigator)||state.wakeLock||!state.active||state.paused||document.visibilityState!=="visible")return;
    try{
      const sentinel=await navigator.wakeLock.request("screen");
      if(!state.active||state.paused){sentinel.release().catch(()=>{});return}
      state.wakeLock=sentinel;
      sentinel.addEventListener("release",()=>{if(state.wakeLock===sentinel)state.wakeLock=null});
    }catch{}
  }
  function releaseWakeLock(){if(state.wakeLock){const sentinel=state.wakeLock;state.wakeLock=null;sentinel.release().catch(()=>{})}}
  function fmtTime(ms){const s=Math.max(0,Math.floor(ms/1000));return [Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(n=>String(n).padStart(2,"0")).join(":")}
  function fmtShortTime(ms){const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")}
  function fmtPace(ms,km){if(!km||km<0.03)return"--:--";const sec=Math.round(ms/1000/km);if(!Number.isFinite(sec)||sec>3600)return"--:--";return Math.floor(sec/60)+":"+String(sec%60).padStart(2,"0")}
  function fmtDate(iso){return new Date(iso).toLocaleString("es-MX",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}
  function haversine(a,b){const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
  function setGps(message,kind=""){$("gpsStatus").textContent=message;$("gpsDot").className="dot"+(kind?" "+kind:"")}
  function elapsedNow(){return state.elapsedBeforeSegment+(state.active&&!state.paused?Date.now()-state.segmentStartedAt:0)}
  function renderMetrics(){state.elapsedMs=elapsedNow();$("distance").innerHTML=state.distance.toFixed(2)+' <span>km</span>';$("duration").textContent=fmtTime(state.elapsedMs);$("pace").textContent=fmtPace(state.elapsedMs,state.distance);$("calories").textContent=String(Math.round(state.distance*60));$("activityLabel").textContent=!state.active?"Sin iniciar":state.paused?"Pausado":"En curso"}
  
  const MAP_CENTER=[16.2885,-94.1943];
  const OSM_ATTRIBUTION='&copy; OpenStreetMap contributors (ODbL)';
  
  function offlineRoadStyle(feature){const highway=(feature.properties||{}).highway;const major=["motorway","trunk","primary","secondary","tertiary"].includes(highway);return{color:major?"#819780":"#b0beb0",weight:major?3.4:1.7,opacity:1,lineCap:"round",lineJoin:"round"}}
  function applyMapMode(map,mode){
    if(!map||!window.L)return;
    if(mode==="satellite"&&!navigator.onLine){
      if($("mapMode"))$("mapMode").value="offline";
      mode="offline";
      alert("La vista satelital necesita internet. Cambié el mapa a calles offline.");
    }
    if(map._zrSatelliteLayer){map.removeLayer(map._zrSatelliteLayer);map._zrSatelliteLayer=null;}
    if(map._zrRoadLayer){map.removeLayer(map._zrRoadLayer);map._zrRoadLayer=null;}
    if(mode==="satellite"){
      map._zrSatelliteLayer=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Sources: Esri, Vantor, Earthstar Geographics, and the GIS User Community"}).addTo(map);
    }else if(roadsData){
      map._zrRoadLayer=L.geoJSON(roadsData,{
        style:offlineRoadStyle,
        onEachFeature:(feature,layer)=>{
          const props=feature.properties||{};
          if(props.name&&["motorway","trunk","primary","secondary","tertiary"].includes(props.highway)){
            layer.bindTooltip(props.name,{sticky:true,className:"road-label",opacity:.92});
          }
        }
      }).addTo(map);
    }
    if(map===liveMap&&liveLine)liveLine.bringToFront();
    if(map===detailMap&&detailLine)detailLine.bringToFront();
  }
  
  function loadOfflineRoads(){if(!roadsLoadPromise){roadsLoadPromise=fetch("./data/chahuites-roads.geojson").then(response=>{if(!response.ok)throw new Error("No se encontró el mapa offline");return response.json()}).then(data=>{if(!data||data.type!=="FeatureCollection"||!Array.isArray(data.features)||!data.features.length)throw new Error("El mapa offline no contiene calles");roadsData=data;if(liveMap)applyMapMode(liveMap,$("mapMode")?$("mapMode").value:"offline");if(detailMap)applyMapMode(detailMap,$("mapMode")?$("mapMode").value:"offline");return data}).catch(()=>{roadsData=null;return null})}return roadsLoadPromise}
  function initMap(){if(!window.L){$("liveMap").innerHTML='<div class="map-fallback">No se pudo cargar el motor de mapas guardado en el dispositivo.</div>';return}liveMap=L.map("liveMap",{zoomControl:true,attributionControl:true}).setView(MAP_CENTER,14);liveMap.attributionControl.addAttribution(OSM_ATTRIBUTION);liveLine=L.polyline([],{color:"#8bbd45",weight:5,lineCap:"round",lineJoin:"round"}).addTo(liveMap);applyMapMode(liveMap,"offline");loadOfflineRoads();setTimeout(()=>liveMap.invalidateSize(),60)}
  
  function start(){
    if(!("geolocation" in navigator)){setGps("GPS no disponible","bad");alert("Este navegador no permite acceder al GPS.");return}
    if(!window.isSecureContext){alert("Por seguridad, el GPS necesita abrir la app desde GitHub Pages (HTTPS).");return}
    if(!storage.ready){alert("Un momento: todavía se están cargando tus actividades guardadas. Inténtalo de nuevo en unos segundos.");return}
    try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{})}catch{} // pide que el navegador no borre los datos
    state.active=true;state.paused=false;$("activityType").disabled=true;
    state.startedAt=Date.now();state.segmentStartedAt=Date.now();
    state.elapsedBeforeSegment=0;state.elapsedMs=0;state.distance=0;
    state.points=[];state.track=[];lastDraftKey="";state.lastPoint=null;state.lastSplitKm=0;state.splits=[];state.maxSpeedKmh=0;
    $("startBtn").hidden=true;$("activeActions").hidden=false;$("pauseBtn").textContent="Ⅱ Pausar";
    setGps("Buscando señal…");renderMetrics();resetLiveMap();
    
    if(ticker) clearInterval(ticker);
    ticker=setInterval(renderMetrics,500);
    if(draftTimer)clearInterval(draftTimer);
    draftTimer=setInterval(saveDraft,15000);

    state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
    requestWakeLock();
  }

  function onPosition(position){
    if(!state.active||state.paused)return;
    const c=position.coords;
    
    if(c.accuracy>25){
      setGps("GPS impreciso ("+Math.round(c.accuracy)+" m), esperando mejor señal","bad");
      return;
    }
    
    const point={lat:c.latitude,lon:c.longitude,accuracy:c.accuracy,time:position.timestamp||Date.now()};
    
    if(state.lastPoint){
      const d=haversine(state.lastPoint,point);
      const seconds=Math.max((point.time-state.lastPoint.time)/1000,.1);
      const speed=d/seconds;
      
      if(d<3)return; // Ignorar micro-movimientos estáticos menores a 3 metros
      if(speed>8.5){setGps("Filtrando salto GPS","bad");return}
      
      state.distance+=d/1000;
      state.maxSpeedKmh=Math.max(state.maxSpeedKmh,speed*3.6);
      const newSplit=Math.floor(state.distance);
      if(newSplit>state.lastSplitKm){
        state.splits.push({km:newSplit,elapsedMs:elapsedNow()});
        state.lastSplitKm=newSplit;
      }
    }
    
    state.lastPoint=point;
    state.track.push([point.lat,point.lon]); // recorrido completo que se guarda
    state.points.push([point.lat,point.lon]); // versión reducida solo para dibujar el mapa en vivo
    if(state.points.length>1800)state.points=state.points.filter((_,i)=>i%2===0);
    setGps("GPS conectado","good");
    renderMetrics();
    renderLiveRoute();
  }

  function onGpsError(error){
    const messages={1:"Permiso de ubicación denegado",2:"No se encuentra señal GPS",3:"GPS tardó demasiado"};
    setGps(messages[error.code]||"Error de GPS","bad");
    if(error.code===1)alert("Activa el permiso de ubicación para tu navegador y vuelve a iniciar el entrenamiento.");
  }

  function pauseToggle(){
    if(!state.active)return;
    if(!state.paused){
      state.elapsedBeforeSegment=elapsedNow();
      state.paused=true;
      if(state.watchId!==null)navigator.geolocation.clearWatch(state.watchId);
      state.watchId=null;
      releaseWakeLock();
      $("pauseBtn").textContent="▶ Reanudar";
      setGps("Entrenamiento pausado");
    }else{
      state.paused=false;
      state.segmentStartedAt=Date.now();
      state.lastPoint=null; // no sumar el desplazamiento ocurrido durante la pausa
      setGps("Buscando señal…");
      state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
      requestWakeLock();
      $("pauseBtn").textContent="Ⅱ Pausar";
    }
    renderMetrics();
  }

  function stopGps(){
    if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;}
    if(ticker){clearInterval(ticker);ticker=null;}
    if(draftTimer){clearInterval(draftTimer);draftTimer=null;}
    releaseWakeLock();
  }

  async function finish(){
    if(!state.active)return;
    state.elapsedMs=elapsedNow();
    stopGps();
    state.active=false;
    state.paused=false;
    $("activityType").disabled=false;
    $("startBtn").hidden=false;
    $("activeActions").hidden=true;
    setGps("GPS listo");
    
    if(state.distance>=.005&&state.elapsedMs>0){
      const item=buildActivityItem({id:Date.now(),type:$("activityType").value,date:new Date().toISOString(),distance:state.distance,elapsedMs:state.elapsedMs,maxSpeedKmh:state.maxSpeedKmh,track:state.track,splits:state.splits});
      if(await commitActivity(item)){
        $("finalDistance").textContent=item.distance.toFixed(2)+" km";
        $("finalDuration").textContent=fmtShortTime(item.durationMs);
        $("finalPace").textContent=item.pace;
        $("finishDialog").showModal();
      }
    }else{
      alert("La actividad no se guardó porque todavía no hay distancia GPS suficiente.");
    }
    renderMetrics();
  }

  function resetLiveMap(){if(!liveMap)return;liveLine.setLatLngs([]);liveMap.setView(MAP_CENTER,14);if(liveStart){liveMap.removeLayer(liveStart);liveStart=null}if(liveEnd){liveMap.removeLayer(liveEnd);liveEnd=null}$("pointsLabel").textContent="Esperando GPS";setTimeout(()=>liveMap.invalidateSize(),50)}
  function renderLiveRoute(){if(!liveMap||!state.points.length)return;const latlngs=state.points.map(p=>[p[0],p[1]]);liveLine.setLatLngs(latlngs);if(!liveStart)liveStart=L.circleMarker(latlngs[0],{radius:6,color:"#fff",weight:2,fillColor:"#8bbd45",fillOpacity:1}).addTo(liveMap);if(liveEnd)liveEnd.setLatLng(latlngs[latlngs.length-1]);else liveEnd=L.circleMarker(latlngs[latlngs.length-1],{radius:7,color:"#132012",weight:2,fillColor:"#c7fa67",fillOpacity:1}).addTo(liveMap);liveMap.fitBounds(liveLine.getBounds(),{padding:[25,25],maxZoom:17});$("pointsLabel").textContent=state.points.length+" puntos GPS"}
  function renderStats(){const totalKm=activities.reduce((n,a)=>n+(Number(a.distance)||0),0),totalMs=activities.reduce((n,a)=>n+(Number(a.durationMs)||0),0);$("totalDistance").innerHTML=totalKm.toFixed(2)+' <i>km</i>';const mins=Math.floor(totalMs/60000);$("totalTime").textContent=Math.floor(mins/60)+" h "+String(mins%60).padStart(2,"0")+" min";$("totalActivities").textContent=String(activities.length);const good=activities.filter(a=>a.distance>0&&a.durationMs>0);good.sort((a,b)=>a.durationMs/a.distance-b.durationMs/b.distance);$("bestPace").innerHTML=(good[0]?fmtPace(good[0].durationMs,good[0].distance):"--:--")+' <i>/km</i>'}
  
  function renderHistory(){
    const list=$("historyList");list.replaceChildren();$("emptyHistory").hidden=activities.length>0||!storage.ready; // no mostrar «sin actividades» mientras aún se cargan
    activities.forEach(a=>{
      const row=document.createElement("div");row.className="history-row";
      const article=document.createElement("button");article.type="button";article.className="history-item history-button";article.setAttribute("aria-label","Ver actividad del "+fmtDate(a.date));
      const icon=document.createElement("div");icon.className="history-icon";icon.textContent="↗";
      const main=document.createElement("div");main.className="history-main";
      const title=document.createElement("strong");title.textContent=a.type==="caminar"?"Caminata":a.type==="correr"?"Carrera":"Carrera o caminata";
      const meta=document.createElement("small");meta.textContent=fmtDate(a.date)+" · "+fmtShortTime(a.durationMs)+" · "+(a.pace||fmtPace(a.durationMs,a.distance))+" min/km";
      const distance=document.createElement("div");distance.className="history-distance";distance.textContent=Number(a.distance).toFixed(2)+" km";
      const sub=document.createElement("small");sub.textContent="≈ "+(a.calories||0)+" kcal";
      distance.appendChild(sub);main.append(title,meta);article.append(icon,main,distance);
      article.addEventListener("click",()=>openActivity(a));
      const deleteBtn=document.createElement("button");deleteBtn.type="button";deleteBtn.className="delete-activity-btn";deleteBtn.textContent="Eliminar";deleteBtn.setAttribute("aria-label","Eliminar "+(a.type==="caminar"?"caminata":"carrera")+" del "+fmtDate(a.date));
      deleteBtn.addEventListener("click",async event=>{
        event.stopPropagation();
        if(!confirm("¿Eliminar esta actividad de "+fmtDate(a.date)+" ("+Number(a.distance).toFixed(2)+" km)? Esta acción no se puede deshacer."))return;
        if(!(await removeActivity(a))){alert("No se pudo eliminar la actividad. Sigue en tu historial; inténtalo de nuevo.");return}
        renderHistory();renderStats();
      });
      row.append(article,deleteBtn);list.appendChild(row);
    });
  }

  function openActivity(a){
    $("detailTitle").textContent=a.type==="caminar"?"Caminata":a.type==="correr"?"Carrera":"Carrera o caminata";
    $("detailDate").textContent=fmtDate(a.date);$("detailDistance").textContent=Number(a.distance).toFixed(2)+" km";
    $("detailDuration").textContent=fmtShortTime(a.durationMs);$("detailPace").textContent=(a.pace||fmtPace(a.durationMs,a.distance))+" /km";
    $("detailCalories").textContent=(a.calories||0)+" kcal";
    const avg=Number(a.avgSpeedKmh)||((Number(a.distance)>0&&Number(a.durationMs)>0)?Number(a.distance)/(Number(a.durationMs)/3600000):0);
    $("detailAvgSpeed").textContent=avg.toFixed(1)+" km/h";$("detailMaxSpeed").textContent=(Number(a.maxSpeedKmh)||0).toFixed(1)+" km/h";
    const splits=$("detailSplits");splits.replaceChildren();const heading=document.createElement("h3");heading.textContent="Parciales por kilómetro";splits.appendChild(heading);
    const rows=Array.isArray(a.splits)?a.splits:[];
    if(!rows.length){const note=document.createElement("p");note.className="muted";note.textContent="No hay parciales guardados para esta actividad.";splits.appendChild(note)}
    else{
      const list=document.createElement("div");list.className="split-list";
      rows.forEach((split,i)=>{
        const row=document.createElement("div");row.className="split-row";
        const km=document.createElement("span");km.textContent="Km "+split.km;
        const time=document.createElement("strong");const previous=i?Number(rows[i-1].elapsedMs)||0:0;
        time.textContent=fmtShortTime(Math.max(0,(Number(split.elapsedMs)||0)-previous));
        row.append(km,time);list.appendChild(row);
      });
      splits.appendChild(list);
    }
    $("detailDialog").showModal();setTimeout(()=>renderDetailMap(a.points||[]),80);
  }

  function renderDetailMap(points){
    if(!window.L){$("detailMap").innerHTML='<div class="map-fallback">Mapa no disponible.</div>';return}
    if(!detailMap){
      detailMap=L.map("detailMap",{zoomControl:true,attributionControl:true}).setView(MAP_CENTER,14);
      detailMap.attributionControl.addAttribution(OSM_ATTRIBUTION);
      detailLine=L.polyline([],{color:"#8bbd45",weight:5,lineCap:"round",lineJoin:"round"}).addTo(detailMap);
      applyMapMode(detailMap,$("mapMode")?$("mapMode").value:"offline");
      if(!roadsData)loadOfflineRoads();
    }
    detailMap.invalidateSize();
    const latlngs=points.map(p=>[p[0],p[1]]);detailLine.setLatLngs(latlngs);
    if(latlngs.length)detailMap.fitBounds(detailLine.getBounds(),{padding:[25,25],maxZoom:17});
    else $("detailMap").innerHTML='<div class="map-fallback">Esta actividad es anterior al mapa guardado. Las próximas sí conservarán la ruta.</div>';
  }
  
  $("activityType").addEventListener("change",()=>{if(!$("activityType").disabled){$("activityLabel").textContent="Preparado para "+($("activityType").value==="caminar"?"caminar":"correr")}});
  $("mapMode").addEventListener("change",()=>{if($("mapMode").value==="satellite"&&!window.confirm("El mapa satelital descarga imágenes por internet y puede consumir tus datos móviles. ¿Quieres continuar?")){$("mapMode").value="offline";return}applyMapMode(liveMap,$("mapMode").value);if(detailMap)applyMapMode(detailMap,$("mapMode").value)});
  $("startBtn").addEventListener("click",start);$("pauseBtn").addEventListener("click",pauseToggle);$("finishBtn").addEventListener("click",finish);
  $("closeDialog").addEventListener("click",()=>$("finishDialog").close());
  $("closeDetail").addEventListener("click",()=>$("detailDialog").close());
  $("closeDetailBottom").addEventListener("click",()=>$("detailDialog").close());
  
  $("exportBtn").addEventListener("click",()=>{if(!activities.length){alert("Todavía no tienes actividades para exportar.");return}const rows=[["fecha","tipo_actividad","distancia_km","duracion_segundos","ritmo_min_km","calorias_estimadas","puntos_gps"],...activities.map(a=>[a.date,a.type||"sin especificar",a.distance,Math.round(a.durationMs/1000),a.pace,a.calories,(a.points||[]).length])];const csv=rows.map(row=>row.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(",")).join("\r\n");const url=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"}));const link=document.createElement("a");link.href=url;link.download="zuniga-running-historial.csv";link.click();URL.revokeObjectURL(url)});
  
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&state.active&&!state.paused){if(state.watchId!==null)navigator.geolocation.clearWatch(state.watchId);state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});requestWakeLock()}if(document.visibilityState==="hidden")saveDraft()});
  window.addEventListener("pagehide",saveDraft);

  initMap();renderMetrics();renderStats();renderHistory();
  initStorage().then(()=>{renderStats();renderHistory();return recoverInterruptedActivity()}).catch(()=>{});
})();
