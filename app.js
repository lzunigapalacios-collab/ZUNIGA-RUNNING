(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "zuniga-running-activities-v2";
  const state = {active:false,paused:false,watchId:null,startedAt:0,segmentStartedAt:0,elapsedBeforeSegment:0,elapsedMs:0,distance:0,points:[],lastPoint:null,lastSplitKm:0,splits:[],maxSpeedKmh:0,wakeLock:null};
  let activities=loadActivities(),ticker=null,liveMap=null,liveLine=null,liveStart=null,liveEnd=null,detailMap=null,detailLine=null,roadsData=null,roadsLoadPromise=null;
  
  function loadActivities(){try{let data=JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]");if(!Array.isArray(data)||!data.length){const old=JSON.parse(localStorage.getItem("zuniga-running-activities-v1")||"[]");data=Array.isArray(old)?old:[]}return data;}catch{return[]}}
  function saveActivities(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(activities))}catch{alert("No se pudieron guardar los datos. El almacenamiento del navegador está lleno.")}}
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
    state.active=true;state.paused=false;$("activityType").disabled=true;
    state.startedAt=Date.now();state.segmentStartedAt=Date.now();
    state.elapsedBeforeSegment=0;state.elapsedMs=0;state.distance=0;
    state.points=[];state.lastPoint=null;state.lastSplitKm=0;state.splits=[];state.maxSpeedKmh=0;
    $("startBtn").hidden=true;$("activeActions").hidden=false;$("pauseBtn").textContent="Ⅱ Pausar";
    setGps("Buscando señal…");renderMetrics();resetLiveMap();
    
    if(ticker) clearInterval(ticker);
    ticker=setInterval(renderMetrics,500);
    
    state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
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
    state.points.push([point.lat,point.lon]);
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
      $("pauseBtn").textContent="▶ Reanudar";
      setGps("Entrenamiento pausado");
    }else{
      state.paused=false;
      state.segmentStartedAt=Date.now();
      setGps("Buscando señal…");
      state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
      $("pauseBtn").textContent="Ⅱ Pausar";
    }
    renderMetrics();
  }

  function stopGps(){
    if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;}
    if(ticker){clearInterval(ticker);ticker=null;}
    if(state.wakeLock){state.wakeLock.release().catch(()=>{});state.wakeLock=null;}
  }

  function finish(){
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
      const item={
        id:Date.now(),
        type:$("activityType").value,
        date:new Date().toISOString(),
        distance:Number(state.distance.toFixed(4)),
        durationMs:Math.round(state.elapsedMs),
        pace:fmtPace(state.elapsedMs,state.distance),
        avgSpeedKmh:state.elapsedMs>0?Number((state.distance/(state.elapsedMs/3600000)).toFixed(2)):0,
        maxSpeedKmh:Number(state.maxSpeedKmh.toFixed(2)),
        calories:Math.round(state.distance*60),
        points:state.points.slice(),
        splits:state.splits.slice()
      };
      activities.unshift(item);
      activities=activities.slice(0,100);
      saveActivities();
      renderHistory();
      renderStats();
      $("finalDistance").textContent=item.distance.toFixed(2)+" km";
      $("finalDuration").textContent=fmtShortTime(item.durationMs);
      $("finalPace").textContent=item.pace;
      $("finishDialog").showModal();
    }else{
      alert("La actividad no se guardó porque todavía no hay distancia GPS suficiente.");
    }
    renderMetrics();
  }

  function resetLiveMap(){if(!liveMap)return;liveLine.setLatLngs([]);liveMap.setView(MAP_CENTER,14);if(liveStart){liveMap.removeLayer(liveStart);liveStart=null}if(liveEnd){liveMap.removeLayer(liveEnd);liveEnd=null}$("pointsLabel").textContent="Esperando GPS";setTimeout(()=>liveMap.invalidateSize(),50)}
  function renderLiveRoute(){if(!liveMap||!state.points.length)return;const latlngs=state.points.map(p=>[p[0],p[1]]);liveLine.setLatLngs(latlngs);if(!liveStart)liveStart=L.circleMarker(latlngs[0],{radius:6,color:"#fff",weight:2,fillColor:"#8bbd45",fillOpacity:1}).addTo(liveMap);if(liveEnd)liveEnd.setLatLng(latlngs[latlngs.length-1]);else liveEnd=L.circleMarker(latlngs[latlngs.length-1],{radius:7,color:"#132012",weight:2,fillColor:"#c7fa67",fillOpacity:1}).addTo(liveMap);liveMap.fitBounds(liveLine.getBounds(),{padding:[25,25],maxZoom:17});$("pointsLabel").textContent=state.points.length+" puntos GPS"}
  function renderStats(){const totalKm=activities.reduce((n,a)=>n+(Number(a.distance)||0),0),totalMs=activities.reduce((n,a)=>n+(Number(a.durationMs)||0),0);$("totalDistance").innerHTML=totalKm.toFixed(2)+' <i>km</i>';const mins=Math.floor(totalMs/60000);$("totalTime").textContent=Math.floor(mins/60)+" h "+String(mins%60).padStart(2,"0")+" min";$("totalActivities").textContent=String(activities.length);const good=activities.filter(a=>a.distance>0&&a.durationMs>0);good.sort((a,b)=>a.durationMs/a.distance-b.durationMs/b.distance);$("bestPace").innerHTML=(good[0]?fmtPace(good[0].durationMs,good[0].distance):"--:--")+' <i>/km</i>'}
  
  function renderHistory(){
    const list=$("historyList");list.replaceChildren();$("emptyHistory").hidden=activities.length>0;
    activities.forEach(a=>{
      const article=document.createElement("button");article.type="button";article.className="history-item history-button";article.setAttribute("aria-label","Ver actividad del "+fmtDate(a.date));
      const icon=document.createElement("div");icon.className="history-icon";icon.textContent="↗";
      const main=document.createElement("div");main.className="history-main";
      const title=document.createElement("strong");title.textContent=a.type==="caminar"?"Caminata":a.type==="correr"?"Carrera":"Carrera o caminata";
      const meta=document.createElement("small");meta.textContent=fmtDate(a.date)+" · "+fmtShortTime(a.durationMs)+" · "+a.pace+" min/km";
      const distance=document.createElement("div");distance.className="history-distance";distance.textContent=Number(a.distance).toFixed(2)+" km";
      const sub=document.createElement("small");sub.textContent="≈ "+(a.calories||0)+" kcal";
      distance.appendChild(sub);main.append(title,meta);article.append(icon,main,distance);
      article.addEventListener("click",()=>openActivity(a));list.appendChild(article);
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
  
  // --- NUEVA FUNCIÓN: IMPORTAR RESPALDOS (JSON) ---
  const historySec = document.querySelector(".history-section .section-title div:last-child") || document.querySelector(".history-section .section-title");
  // Añadimos el botón de importar al lado del de exportar si no existe
  if(!$("importBtn") && $("exportBtn")){
    const impBtn = document.createElement("button");
    impBtn.id = "importBtn";
    impBtn.className = "text-button";
    impBtn.textContent = "Importar ↗";
    $("exportBtn").parentNode.insertBefore(impBtn, $("exportBtn"));
    
    const fileInp = document.createElement("input");
    fileInp.type = "file";
    fileInp.id = "importFile";
    fileInp.accept = ".json";
    fileInp.style.display = "none";
    document.body.appendChild(fileInp);

    impBtn.addEventListener("click", () => fileInp.click());
    fileInp.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target.result);
          if(!Array.isArray(imported)) throw new Error();
          if(confirm(`Se encontraron ${imported.length} actividades. ¿Deseas fusionarlas con tu historial actual?\n\n- Aceptar: Fusionar\n- Cancelar: Reemplazar todo`)){
            const existingIds = new Set(activities.map(a => a.id));
            activities = [...imported.filter(item => !existingIds.has(item.id)), ...activities];
          } else {
            activities = imported;
          }
          activities = activities.slice(0, 100);
          saveActivities();
          renderHistory();
          renderStats();
          alert("¡Historial importado exitosamente!");
        } catch {
          alert("El archivo no es válido. Asegúrate de importar un respaldo JSON correcto.");
        } finally {
          fileInp.value = "";
        }
      };
      reader.readAsText(file);
    });
  }

  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&state.active&&!state.paused){if(state.watchId!==null)navigator.geolocation.clearWatch(state.watchId);state.watchId=navigator.geolocation.watchPosition(onPosition,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000})}});
  
  initMap();renderMetrics();renderStats();renderHistory();
})();
