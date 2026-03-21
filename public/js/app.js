'use strict';
const API={
  async get(p){const r=await fetch(p);if(!r.ok)throw new Error(await r.text());return r.json()},
  async post(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json()},
  async put(p,b){const r=await fetch(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json()},
  async del(p){const r=await fetch(p,{method:'DELETE'});return r.json()},
  async upload(p,f){const r=await fetch(p,{method:'POST',body:f});return r.json()},
};
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtDur(s){if(!s)return'0:00';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`}
function fmtTime(ts){if(!ts)return'';return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function notify(msg,err=false){const el=document.getElementById('notif');el.textContent=msg;el.className='notif show'+(err?' err':'');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),3500)}

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg=document.getElementById('page-'+name);if(!pg)return;
  pg.classList.add('active');
  document.getElementById('page-title').textContent=name.toUpperCase().replace('-',' ');
  document.querySelectorAll(`[data-page="${name}"]`).forEach(n=>n.classList.add('active'));
  const h={dashboard:loadDashboard,libraries:loadLibraries,media:()=>loadMedia(1),channels:loadChannels,playout:loadPlayout,schedule:initSchedule,watch:loadWatch,'epg-import':loadEpgImport,'epg-browser':loadEpgBrowser,'ai-scheduler':loadAiScheduler,output:loadOutput,plex:loadSetupUrls,jellyfin:loadSetupUrls,settings:loadSettings};
  if(h[name])h[name]();
}
function openModal(id){document.getElementById(id).classList.add('open')}
function closeModal(id){document.getElementById(id).classList.remove('open')}
document.querySelectorAll('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));
document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>closeModal(el.dataset.close)));
document.querySelectorAll('[data-goto]').forEach(el=>el.addEventListener('click',()=>showPage(el.dataset.goto)));
document.querySelectorAll('.nav-item[data-page]').forEach(el=>el.addEventListener('click',()=>showPage(el.dataset.page)));
document.querySelectorAll('[data-copy]').forEach(btn=>btn.addEventListener('click',()=>{navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).value).then(()=>notify('📋 Copied!'))}));

// ── Status ────────────────────────────────────────────────────────────────────
async function checkStatus(){
  try{
    const s=await API.get('/api/status');
    document.getElementById('server-dot').className='status-dot online';
    document.getElementById('server-status').textContent=`v${s.version}`;
    document.getElementById('nav-ch-count').textContent=s.channels;
    document.getElementById('nav-lib-count').textContent=s.libraries;
  }catch{document.getElementById('server-dot').className='status-dot error';document.getElementById('server-status').textContent='Offline'}
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard(){
  try{
    const s=await API.get('/api/status');
    document.getElementById('stat-channels').textContent=s.channels;
    document.getElementById('stat-libraries').textContent=s.libraries;
    document.getElementById('stat-media').textContent=s.media;
    const ffEl=document.getElementById('stat-ffmpeg');
    ffEl.textContent=s.ffmpeg?'✓ Ready':'✗ Missing';
    ffEl.style.color=s.ffmpeg?'var(--success)':'var(--accent2)';

    // Now playing
    const chs=await API.get('/api/channels');
    const nowEl=document.getElementById('dash-now-playing');
    if(!chs.length){nowEl.innerHTML='<div class="empty-state"><div class="empty-icon">▶️</div><div class="empty-text">No channels yet</div></div>';return}
    const rows=await Promise.all(chs.filter(c=>c.active&&(c.playout||[]).length).map(async ch=>{
      try{const np=await API.get(`/api/channels/${ch.id}/now-playing`);return{ch,np}}catch{return{ch,np:{item:null}}}
    }));
    const playing=rows.filter(r=>r.np.item);
    nowEl.innerHTML=playing.length
      ?playing.map(r=>`<div class="now-playing-row"><span class="np-ch">${r.ch.num}</span><div class="np-info"><div class="np-title">${esc(r.np.item.title)}</div><div class="np-meta">${esc(r.ch.name)} · ${fmtDur(r.np.item.duration)}</div></div><span class="np-live">LIVE</span></div>`).join('')
      :'<div class="empty-state"><div class="empty-icon">▶️</div><div class="empty-text">No playout configured yet</div></div>';

    // Libraries
    const libs=await API.get('/api/libraries');
    const libEl=document.getElementById('dash-libraries');
    libEl.innerHTML=libs.length
      ?libs.map(l=>`<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border)"><span style="font-size:1.2rem">${l.type==='plex'?'🟡':l.type==='jellyfin'?'🟣':'📁'}</span><div style="flex:1"><div style="font-weight:600;color:var(--text);font-size:.86rem">${esc(l.name)}</div><div style="font-size:.74rem;color:var(--text3)">${l.itemCount||0} items${l.scannedAt?' · '+new Date(l.scannedAt).toLocaleDateString():''}</div></div></div>`).join('')
      :'<div class="empty-state"><div class="empty-icon">🗄️</div><div class="empty-text">No libraries added yet</div></div>';
  }catch(e){console.error('Dashboard',e)}
}

// ── Libraries ─────────────────────────────────────────────────────────────────
async function loadLibraries(){
  try{
    const libs=await API.get('/api/libraries');
    const el=document.getElementById('libraries-list');
    el.innerHTML=libs.length?libs.map(l=>`
      <div class="library-card">
        <div class="library-icon">${l.type==='plex'?'🟡':l.type==='jellyfin'?'🟣':'📁'}</div>
        <div class="library-info">
          <div class="library-name">${esc(l.name)} <span class="badge badge-${l.type}">${l.type}</span></div>
          <div class="library-meta">${esc(l.path||l.url||'')} · ${l.itemCount||0} items${l.scannedAt?' · Scanned '+new Date(l.scannedAt).toLocaleString():' · Not scanned yet'}</div>
        </div>
        <div class="library-actions">
          <button class="btn btn-secondary btn-sm" onclick="scanLibrary('${l.id}',this)">↻ Scan</button>
          <button class="btn btn-danger btn-sm" onclick="deleteLibrary('${l.id}')">✕</button>
        </div>
      </div>`).join('')
      :'<div class="empty-state"><div class="empty-icon">🗄️</div><div class="empty-text">No libraries yet. Add a local folder, Plex or Jellyfin library to get started.</div></div>';
    // Update picker lib dropdowns
    const opts='<option value="">All Libraries</option>'+libs.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('');
    ['media-lib-filter','picker-lib'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=opts});
  }catch(e){console.error(e)}
}

async function scanLibrary(id,btn){
  btn.textContent='Starting...';btn.disabled=true;
  try{
    // Trigger scan — server responds immediately, scan runs in background
    const r=await API.post(`/api/libraries/${id}/scan`,{});
    if(r.error){notify('Scan error: '+r.error,true);btn.textContent='↻ Scan';btn.disabled=false;return}
    notify('⏳ Scanning library — this may take a few minutes for large libraries...');
    btn.textContent='Scanning...';
    // Poll for completion every 3 seconds
    let polls=0;
    const poll=async()=>{
      polls++;
      try{
        const st=await API.get(`/api/libraries/${id}/scan-status`);
        if(st.scanError){
          notify('Scan error: '+st.scanError,true);
          btn.textContent='↻ Scan';btn.disabled=false;
          loadLibraries();
          return;
        }
        if(st.scannedAt){
          const lastScan=new Date(st.scannedAt).getTime();
          const now=Date.now();
          // If scannedAt was updated in the last 10 minutes, scan is done
          if(now-lastScan<600000){
            notify(`✅ Scan complete — ${st.itemCount} items`);
            btn.textContent='↻ Scan';btn.disabled=false;
            loadLibraries();checkStatus();
            return;
          }
        }
        // Keep polling up to 10 minutes
        if(polls<200)setTimeout(poll,3000);
        else{notify('Scan taking too long — check server logs',true);btn.textContent='↻ Scan';btn.disabled=false;loadLibraries();}
      }catch(e){
        if(polls<200)setTimeout(poll,3000);
      }
    };
    setTimeout(poll,3000);
  }catch(e){notify('Scan failed: '+e.message,true);btn.textContent='↻ Scan';btn.disabled=false}
}

async function deleteLibrary(id){
  if(!confirm('Remove this library and all its media items?'))return;
  await API.del('/api/libraries/'+id);
  loadLibraries();checkStatus();notify('Library removed');
}

// Library modal
let libType='local';
document.querySelectorAll('.type-tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.type-tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    libType=t.dataset.type;
    document.getElementById('lib-fields-local').style.display=libType==='local'?'':'none';
    document.getElementById('lib-fields-plex').style.display=libType==='plex'?'':'none';
    document.getElementById('lib-fields-jellyfin').style.display=libType==='jellyfin'?'':'none';
  });
});

// Fetch Plex sections
document.getElementById('btn-fetch-plex-sections').addEventListener('click',async()=>{
  const url=document.getElementById('lib-plex-url').value.trim();
  const token=document.getElementById('lib-plex-token').value.trim();
  if(!url||!token){notify('Enter URL and token first',true);return}
  const btn=document.getElementById('btn-fetch-plex-sections');
  btn.textContent='Loading...';btn.disabled=true;
  try{
    const sections=await API.post('/api/libraries/plex-sections',{url,token});
    if(sections.error){notify('Plex error: '+sections.error,true);return}
    const sel=document.getElementById('lib-plex-section');
    sel.innerHTML=sections.map(s=>`<option value="${esc(String(s.key))}">${esc(s.title)} (${s.type}${s.count?' · '+s.count+' items':''})</option>`).join('');
    sel.disabled=false;
    // Auto-set library name if empty
    if(!document.getElementById('lib-name').value&&sections[0])
      document.getElementById('lib-name').value=sections[0].title;
    notify(`✅ Found ${sections.length} Plex libraries`);
  }catch(e){notify('Failed: '+e.message,true)}
  finally{btn.textContent='Fetch Libraries';btn.disabled=false}
});

// Fetch Jellyfin libraries
document.getElementById('btn-fetch-jf-libraries').addEventListener('click',async()=>{
  const url=document.getElementById('lib-jf-url').value.trim();
  const token=document.getElementById('lib-jf-token').value.trim();
  if(!url||!token){notify('Enter URL and API key first',true);return}
  const btn=document.getElementById('btn-fetch-jf-libraries');
  btn.textContent='Loading...';btn.disabled=true;
  try{
    const libs=await API.post('/api/libraries/jellyfin-libraries',{url,token});
    if(libs.error){notify('Jellyfin error: '+libs.error,true);return}
    const sel=document.getElementById('lib-jf-library');
    const typeLabel={movies:'Movies',tvshows:'TV Shows',music:'Music',books:'Books',mixed:'Mixed'};
    sel.innerHTML=libs.map(l=>`<option value="${esc(l.id)}">${esc(l.name)} (${typeLabel[l.type]||l.type})</option>`).join('');
    sel.disabled=false;
    if(!document.getElementById('lib-name').value&&libs[0])
      document.getElementById('lib-name').value=libs[0].name;
    notify(`✅ Found ${libs.length} Jellyfin libraries`);
  }catch(e){notify('Failed: '+e.message,true)}
  finally{btn.textContent='Fetch Libraries';btn.disabled=false}
});

document.getElementById('btn-save-library').addEventListener('click',async()=>{
  const name=document.getElementById('lib-name').value.trim();
  if(!name){notify('Name required',true);return}
  const payload={name,type:libType};
  if(libType==='local') payload.path=document.getElementById('lib-path').value.trim();
  if(libType==='plex'){
    payload.url=document.getElementById('lib-plex-url').value.trim();
    payload.token=document.getElementById('lib-plex-token').value.trim();
    const sec=document.getElementById('lib-plex-section');
    if(sec&&sec.value) payload.sectionKey=sec.value;
  }
  if(libType==='jellyfin'){
    payload.url=document.getElementById('lib-jf-url').value.trim();
    payload.token=document.getElementById('lib-jf-token').value.trim();
    const jfl=document.getElementById('lib-jf-library');
    if(jfl&&jfl.value) payload.parentId=jfl.value;
  }
  try{
    const r=await API.post('/api/libraries',payload);
    if(r.error){notify(r.error,true);return}
    notify(`✅ Library "${name}" added`);
    closeModal('modal-library');
    document.getElementById('lib-name').value='';
    loadLibraries();checkStatus();
  }catch(e){notify('Failed: '+e.message,true)}
});

// ── Media Browser ─────────────────────────────────────────────────────────────
let mediaPage = 1;
let mediaBreadcrumb = []; // [{label, action}]
let mediaAllItems = []; // cached full result for grouping

async function loadMedia(page=1) {
  mediaPage = page;
  const q    = document.getElementById('media-search').value;
  const lib  = document.getElementById('media-lib-filter').value;
  const type = document.getElementById('media-type-filter').value;

  // If searching or filtering to movies, show flat grid
  if (q || type === 'movie') {
    await loadMediaFlat(page, q, lib, type);
    return;
  }

  // Default: grouped view — Movies flat, TV Shows grouped by series
  if (type === 'episode') {
    // Grouped TV view
    await loadMediaGrouped(lib);
    return;
  }

  // No type filter: show Movies section + TV Shows section
  await loadMediaHome(lib, q);
}

async function loadMediaHome(lib, q) {
  const grid = document.getElementById('media-grid');
  const pag  = document.getElementById('media-pagination');
  pag.innerHTML = '';
  setBreadcrumb([]);

  try {
    // Fetch all (up to 2000) to group
    let url = `/api/media?page=1&limit=2000`;
    if (lib) url += `&libraryId=${lib}`;
    if (q)   url += `&q=${encodeURIComponent(q)}`;
    const d = await API.get(url);
    mediaAllItems = d.items;

    const movies   = d.items.filter(m => m.type === 'movie');
    const episodes = d.items.filter(m => m.type === 'episode');

    // Group episodes by show title
    const shows = groupByShow(episodes);

    if (!d.items.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🎬</div><div class="empty-text">No media found. Add a library and scan it.</div></div>';
      return;
    }

    let html = '';

    // Movies section
    if (movies.length) {
      html += `<div class="media-section-header" style="grid-column:1/-1">
        <span>🎬 Movies</span><span class="media-section-count">${movies.length}</span>
      </div>`;
      html += movies.slice(0,12).map(m => renderMovieCard(m)).join('');
      if (movies.length > 12) {
        html += `<div class="media-more-card" onclick="loadMediaFlat(1,'',\'${lib}\',' movie')" style="grid-column:span 1">
          <div class="media-more-inner">+${movies.length-12} more</div>
        </div>`;
      }
    }

    // TV Shows section
    if (shows.size) {
      html += `<div class="media-section-header" style="grid-column:1/-1">
        <span>📺 TV Shows</span><span class="media-section-count">${shows.size} shows · ${episodes.length} episodes</span>
      </div>`;
      for (const [showTitle, showEps] of shows) {
        html += renderShowCard(showTitle, showEps);
      }
    }

    grid.innerHTML = html;
  } catch(e) { console.error(e); }
}

async function loadMediaGrouped(lib) {
  const grid = document.getElementById('media-grid');
  const pag  = document.getElementById('media-pagination');
  pag.innerHTML = '';
  setBreadcrumb([{label:'TV Shows', action:()=>loadMedia(1)}]);
  try {
    let url = `/api/media?page=1&limit=5000&type=episode`;
    if (lib) url += `&libraryId=${lib}`;
    const d = await API.get(url);
    const shows = groupByShow(d.items);
    let html = '';
    for (const [showTitle, showEps] of shows) {
      html += renderShowCard(showTitle, showEps);
    }
    grid.innerHTML = html || '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">📺</div><div class="empty-text">No TV episodes found.</div></div>';
  } catch(e) { console.error(e); }
}

async function loadMediaFlat(page=1, q='', lib='', type='') {
  mediaPage = page;
  let url = `/api/media?page=${page}&limit=60`;
  if (q)    url += `&q=${encodeURIComponent(q)}`;
  if (lib)  url += `&libraryId=${lib}`;
  if (type) url += `&type=${type.trim()}`;
  try {
    const d = await API.get(url);
    const grid = document.getElementById('media-grid');
    grid.innerHTML = d.items.length
      ? d.items.map(m => m.type==='movie' ? renderMovieCard(m) : renderEpisodeCard(m)).join('')
      : '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🎬</div><div class="empty-text">No media found.</div></div>';
    const pages = Math.ceil(d.total / d.limit);
    const pag   = document.getElementById('media-pagination');
    pag.innerHTML = pages > 1
      ? Array.from({length:Math.min(pages,10)},(_,i)=>{const p=i+1;return`<button class="page-btn${p===page?' active':''}" onclick="loadMediaFlat(${p},'${q}','${lib}','${type}')">${p}</button>`}).join('')
      : '';
  } catch(e) { console.error(e); }
}

function groupByShow(episodes) {
  const map = new Map();
  episodes.forEach(ep => {
    const key = ep.title || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ep);
  });
  // Sort by show name
  return new Map([...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])));
}

function renderMovieCard(m) {
  return `<div class="media-card" title="${esc(m.title)}">
    <div class="media-thumb">
      ${m.thumb?`<img src="${esc(m.thumb)}" loading="lazy" onerror="this.parentElement.innerHTML='🎬'">`:' <span>🎬</span>'}
    </div>
    <div class="media-info">
      <div class="media-title">${esc(m.title)}</div>
      <div class="media-meta">${m.year||''} · ${fmtDur(m.duration)}</div>
    </div>
  </div>`;
}

function renderShowCard(showTitle, eps) {
  // Pick best thumb: first ep with a thumb
  const thumb = eps.find(e=>e.thumb)?.thumb || null;
  const seasons = [...new Set(eps.map(e=>e.season).filter(Boolean))].sort((a,b)=>a-b);
  const seasonCount = seasons.length;
  const epCount = eps.length;
  return `<div class="media-card show-card" onclick="openShow('${esc(showTitle.replace(/'/g,"\'"))}')">
    <div class="media-thumb">
      ${thumb?`<img src="${esc(thumb)}" loading="lazy" onerror="this.parentElement.innerHTML='📺'"`+`>`:'<span>📺</span>'}
      <div class="show-badge">${seasonCount} season${seasonCount!==1?'s':''}</div>
    </div>
    <div class="media-info">
      <div class="media-title">${esc(showTitle)}</div>
      <div class="media-meta">${epCount} episode${epCount!==1?'s':''}</div>
    </div>
  </div>`;
}

function renderEpisodeCard(ep) {
  return `<div class="media-card" title="${esc(ep.title)} S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')}">
    <div class="media-thumb">
      ${ep.thumb?`<img src="${esc(ep.thumb)}" loading="lazy" onerror="this.parentElement.innerHTML='📺'"`+`>`:'<span>📺</span>'}
      <div class="ep-badge">S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')}</div>
    </div>
    <div class="media-info">
      <div class="media-title">${esc(ep.title)}</div>
      <div class="media-meta">S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')} · ${fmtDur(ep.duration)}</div>
    </div>
  </div>`;
}

function openShow(showTitle) {
  // Show all seasons for this show
  const grid = document.getElementById('media-grid');
  const pag  = document.getElementById('media-pagination');
  pag.innerHTML = '';
  setBreadcrumb([
    {label:'All Media', action:()=>loadMedia(1)},
    {label:showTitle,   action:null},
  ]);

  const eps = mediaAllItems.filter(m => m.title === showTitle && m.type === 'episode');
  if (!eps.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-text">No episodes found.</div></div>'; return; }

  const seasons = [...new Set(eps.map(e=>e.season).filter(Boolean))].sort((a,b)=>a-b);

  let html = '';
  for (const s of seasons) {
    const seasonEps = eps.filter(e=>e.season===s).sort((a,b)=>(a.episode||0)-(b.episode||0));
    const thumb = seasonEps.find(e=>e.thumb)?.thumb || null;
    html += `<div class="media-card season-card" onclick="openSeason('${esc(showTitle.replace(/'/g,"\'"))}',${s})">
      <div class="media-thumb">
        ${thumb?`<img src="${esc(thumb)}" loading="lazy" onerror="this.parentElement.innerHTML='🎞️'"`+`>`:'<span>🎞️</span>'}
        <div class="show-badge">Season ${s}</div>
      </div>
      <div class="media-info">
        <div class="media-title">Season ${s}</div>
        <div class="media-meta">${seasonEps.length} episode${seasonEps.length!==1?'s':''}</div>
      </div>
    </div>`;
  }
  grid.innerHTML = html;
}

function openSeason(showTitle, seasonNum) {
  const grid = document.getElementById('media-grid');
  const pag  = document.getElementById('media-pagination');
  pag.innerHTML = '';
  setBreadcrumb([
    {label:'All Media',      action:()=>loadMedia(1)},
    {label:showTitle,        action:()=>openShow(showTitle)},
    {label:`Season ${seasonNum}`, action:null},
  ]);

  const eps = mediaAllItems
    .filter(m => m.title === showTitle && m.type === 'episode' && m.season === seasonNum)
    .sort((a,b)=>(a.episode||0)-(b.episode||0));

  grid.innerHTML = eps.length
    ? eps.map(ep => renderEpisodeCard(ep)).join('')
    : '<div class="empty-state" style="grid-column:1/-1"><div class="empty-text">No episodes found.</div></div>';
}

function setBreadcrumb(crumbs) {
  mediaBreadcrumb = crumbs;
  const el = document.getElementById('media-breadcrumb');
  if (!el) return;
  if (!crumbs.length) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = crumbs.map((c,i) => {
    if (i < crumbs.length - 1 && c.action) {
      return `<span class="breadcrumb-link" onclick="(${c.action.toString()})()">${esc(c.label)}</span><span class="breadcrumb-sep">›</span>`;
    }
    return `<span class="breadcrumb-cur">${esc(c.label)}</span>`;
  }).join('');
}

document.getElementById('media-search').addEventListener('input', ()=>loadMedia(1));
document.getElementById('media-lib-filter').addEventListener('change', ()=>loadMedia(1));
document.getElementById('media-type-filter').addEventListener('change', ()=>loadMedia(1));

// ── Channels ──────────────────────────────────────────────────────────────────
let editingChId=null;
async function loadChannels(){
  try{
    const chs=await API.get('/api/channels');
    const el=document.getElementById('channels-list');
    el.innerHTML=chs.length?chs.map(c=>`
      <div class="channel-card">
        <div class="channel-num">${c.num}</div>
        <div class="channel-info">
          <div class="channel-name">${esc(c.name)}</div>
          <div class="channel-meta">${esc(c.group||'No group')} · ${(c.playout||[]).length} items in playout</div>
        </div>
        <div class="channel-actions">
          <button class="btn btn-secondary btn-sm" onclick="openEditChannel('${c.id}')">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="goToPlayout('${c.id}')">▶ Playout</button>
          <button class="btn btn-secondary btn-sm" onclick="goToWatch('${c.id}')">📺 Watch</button>
          <button class="btn btn-danger btn-sm" onclick="deleteChannel('${c.id}')">✕</button>
        </div>
      </div>`).join(''):'<div class="empty-state"><div class="empty-icon">📺</div><div class="empty-text">No channels yet.</div></div>';
    // Update playout channel select
    const sel=document.getElementById('playout-channel-select');
    const cur=sel.value;
    sel.innerHTML='<option value="">Select a channel...</option>'+chs.map(c=>`<option value="${c.id}">${c.num} — ${esc(c.name)}</option>`).join('');
    if(cur)sel.value=cur;
  }catch(e){console.error(e)}
}

async function openEditChannel(id){
  try{
    const c=await API.get('/api/channels/'+id);
    editingChId=id;
    document.getElementById('ch-num').value=c.num;
    document.getElementById('ch-name').value=c.name;
    document.getElementById('ch-group').value=c.group||'';
    document.getElementById('ch-logo').value=c.logo||'';
    document.getElementById('modal-ch-title').innerHTML=`Edit Channel <span class="modal-close" data-close="modal-channel">✕</span>`;
    document.querySelector('#modal-ch-title .modal-close').addEventListener('click',()=>closeModal('modal-channel'));
    openModal('modal-channel');
  }catch{notify('Error loading channel',true)}
}

async function saveChannel(){
  const name=document.getElementById('ch-name').value.trim();
  if(!name){notify('Name required',true);return}
  const payload={num:parseInt(document.getElementById('ch-num').value)||undefined,name,group:document.getElementById('ch-group').value.trim(),logo:document.getElementById('ch-logo').value.trim()};
  try{
    if(editingChId)await API.put('/api/channels/'+editingChId,payload);
    else await API.post('/api/channels',payload);
    notify(`✅ Channel "${name}" saved`);
    editingChId=null;
    closeModal('modal-channel');
    ['ch-num','ch-name','ch-group','ch-logo'].forEach(id=>document.getElementById(id).value='');
    loadChannels();checkStatus();
  }catch{notify('Save failed',true)}
}

async function deleteChannel(id){
  if(!confirm('Delete this channel?'))return;
  await API.del('/api/channels/'+id);
  loadChannels();checkStatus();notify('Channel deleted');
}

function goToWatch(id){
  showPage('watch');
  // Small delay to let the page render first
  setTimeout(()=>tuneToChannel(id), 200);
}

function goToPlayout(id){
  showPage('playout');
  document.getElementById('playout-channel-select').value=id;
  loadPlayoutForChannel(id);
}

// ── Playout Builder ───────────────────────────────────────────────────────────
let playoutQueue=[];
let currentPlayoutChannelId=null;
let pickerPage=1;

async function loadPlayout(){
  loadChannels();
  loadPickerMedia(1);
}

document.getElementById('playout-channel-select').addEventListener('change',e=>{
  const id=e.target.value;
  if(id)loadPlayoutForChannel(id);
  else{document.getElementById('playout-editor').style.display='none';document.getElementById('playout-no-channel').style.display=''}
});

async function loadPlayoutForChannel(id){
  currentPlayoutChannelId=id;
  document.getElementById('playout-editor').style.display='';
  document.getElementById('playout-no-channel').style.display='none';
  try{
    const ch=await API.get('/api/channels/'+id);
    const blocks=await API.get(`/api/channels/${id}/playout`);
    playoutQueue=blocks.map(b=>({mediaId:b.mediaId,item:b.item}));
    if(ch.playoutStart){
      const d=new Date(ch.playoutStart);
      document.getElementById('playout-start-input').value=d.toISOString().slice(0,16);
    }else{
      document.getElementById('playout-start-input').value='';
    }
    renderPlayoutQueue();
    loadPickerMedia(1);
  }catch(e){notify('Error loading playout: '+e.message,true)}
}

function renderPlayoutQueue(){
  const el=document.getElementById('playout-queue');
  const totalDur=playoutQueue.reduce((s,b)=>s+(b.item?.duration||0),0);
  document.getElementById('playout-total-dur').textContent=playoutQueue.length?`${playoutQueue.length} items · ${fmtDur(totalDur)} loop`:'';
  if(!playoutQueue.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">▶️</div><div class="empty-text">Add media from the browser →</div></div>';return}
  el.innerHTML=playoutQueue.map((b,i)=>`
    <div class="playout-item" data-index="${i}">
      <span class="playout-drag" title="Drag to reorder">⠿</span>
      <span class="playout-num">${i+1}</span>
      <span class="playout-title" title="${esc(b.item?.title||b.mediaId)}">${b.item?`${b.item.season?`S${String(b.item.season).padStart(2,'0')}E${String(b.item.episode||0).padStart(2,'0')} — `:''}${esc(b.item.title)}`:'Unknown'}</span>
      <span class="playout-dur">${fmtDur(b.item?.duration||0)}</span>
      <span class="playout-remove" onclick="removeFromQueue(${i})">✕</span>
    </div>`).join('');
  initDragSort();
}

function addToQueue(mediaId,item){
  playoutQueue.push({mediaId,item});
  renderPlayoutQueue();
  notify(`✅ Added: ${item.title}`);
}

function removeFromQueue(i){
  playoutQueue.splice(i,1);
  renderPlayoutQueue();
}

document.getElementById('btn-playout-clear').addEventListener('click',()=>{if(confirm('Clear the playout queue?')){playoutQueue=[];renderPlayoutQueue()}});

document.getElementById('btn-playout-save').addEventListener('click',async()=>{
  if(!currentPlayoutChannelId)return;
  const startVal=document.getElementById('playout-start-input').value;
  const playoutStart=startVal?new Date(startVal).toISOString():null;
  try{
    await API.put(`/api/channels/${currentPlayoutChannelId}/playout`,{
      playout:playoutQueue.map(b=>({mediaId:b.mediaId})),
      playoutStart,
    });
    notify('✅ Playout saved');
    loadChannels();
  }catch{notify('Save failed',true)}
});

// Drag to reorder
function initDragSort(){
  const items=document.querySelectorAll('.playout-item');
  let dragging=null;
  items.forEach(item=>{
    item.setAttribute('draggable','true');
    item.addEventListener('dragstart',()=>{dragging=item;item.style.opacity='.4'});
    item.addEventListener('dragend',()=>{item.style.opacity='1';dragging=null});
    item.addEventListener('dragover',e=>{e.preventDefault();if(dragging&&dragging!==item){const rect=item.getBoundingClientRect();const mid=rect.top+rect.height/2;item.parentNode.insertBefore(dragging,e.clientY<mid?item:item.nextSibling)}});
  });
  document.getElementById('playout-queue').addEventListener('drop',()=>{
    const newOrder=[];
    document.querySelectorAll('.playout-item').forEach(el=>{
      const i=parseInt(el.dataset.index);
      if(playoutQueue[i])newOrder.push(playoutQueue[i]);
    });
    playoutQueue=newOrder;
    renderPlayoutQueue();
  });
}

// Media picker
let pickerShowFilter = null; // null=top level, string=show name, number=season

async function loadPickerMedia(page=1){
  pickerPage=page;
  pickerShowFilter=null;
  const q    = document.getElementById('picker-search').value;
  const lib  = document.getElementById('picker-lib').value;
  const type = document.getElementById('picker-type').value;

  // If searching or type=movie, show flat list
  if(q || type==='movie'){
    await loadPickerFlat(page,q,lib,type);
    return;
  }
  // If type=episode, show grouped TV
  if(type==='episode'){
    await loadPickerShows(lib);
    return;
  }
  // Default: mixed — show movies flat + TV shows grouped
  await loadPickerFlat(page,q,lib,type);
}

async function loadPickerFlat(page,q,lib,type){
  let url=`/api/media?page=${page}&limit=30`;
  if(q)   url+=`&q=${encodeURIComponent(q)}`;
  if(lib) url+=`&libraryId=${lib}`;
  if(type)url+=`&type=${type}`;
  try{
    const d=await API.get(url);
    renderPickerItems(d.items, Math.ceil(d.total/30), page);
  }catch(e){console.error(e)}
}

async function loadPickerShows(lib){
  let url=`/api/media?page=1&limit=5000&type=episode`;
  if(lib) url+=`&libraryId=${lib}`;
  try{
    const d=await API.get(url);
    const shows=groupByShow(d.items);
    const el=document.getElementById('picker-results');
    el.innerHTML=shows.size ? [...shows.entries()].map(([title,eps])=>{
      const thumb=eps.find(e=>e.thumb)?.thumb||null;
      const seasons=[...new Set(eps.map(e=>e.season).filter(Boolean))].length;
      return `<div class="picker-item picker-show" onclick="openPickerShow('${esc(title.replace(/'/g,"\'"))}')">
        <div class="picker-thumb">${thumb?`<img src="${esc(thumb)}" loading="lazy" onerror="this.style.display='none'"`+'>'  :''}📺</div>
        <div class="picker-info"><div class="picker-title">${esc(title)}</div><div class="picker-meta">${seasons} season${seasons!==1?'s':''} · ${eps.length} eps</div></div>
        <span class="picker-add" style="color:var(--text3)">›</span>
      </div>`;
    }).join('') : '<div style="padding:16px;color:var(--text3);font-size:.84rem">No TV shows found</div>';
    document.getElementById('picker-pagination').innerHTML='';
  }catch(e){console.error(e)}
}

async function openPickerShow(showTitle){
  pickerShowFilter=showTitle;
  const lib=document.getElementById('picker-lib').value;
  let url=`/api/media?page=1&limit=5000&type=episode`;
  if(lib)url+=`&libraryId=${lib}`;
  try{
    const d=await API.get(url);
    const showEps=d.items.filter(m=>m.title===showTitle&&m.type==='episode');
    const seasons=[...new Set(showEps.map(e=>e.season).filter(Boolean))].sort((a,b)=>a-b);
    const el=document.getElementById('picker-results');
    // Back button + season list
    el.innerHTML=`<div class="picker-item picker-back" onclick="loadPickerMedia(1)" style="border-bottom:1px solid var(--border);margin-bottom:4px">
      <span style="color:var(--accent)">‹</span>
      <div class="picker-info"><div class="picker-title" style="color:var(--text2)">← ${esc(showTitle)}</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();addAllEpsToQueue('${esc(showTitle.replace(/'/g,"\'"))}')">＋ All</button>
      </div>
    </div>`+
    seasons.map(s=>{
      const sEps=showEps.filter(e=>e.season===s);
      return `<div class="picker-item picker-season" onclick="openPickerSeason('${esc(showTitle.replace(/'/g,"\'"))}',${s})">
        <div class="picker-thumb">🎞️</div>
        <div class="picker-info"><div class="picker-title">Season ${s}</div><div class="picker-meta">${sEps.length} episodes</div></div>
        <span class="picker-add" style="color:var(--text3)">›</span>
      </div>`;
    }).join('');
    document.getElementById('picker-pagination').innerHTML='';
  }catch(e){console.error(e)}
}

async function openPickerSeason(showTitle, seasonNum){
  const lib=document.getElementById('picker-lib').value;
  let url=`/api/media?page=1&limit=5000&type=episode`;
  if(lib)url+=`&libraryId=${lib}`;
  try{
    const d=await API.get(url);
    const eps=d.items
      .filter(m=>m.title===showTitle&&m.type==='episode'&&m.season===seasonNum)
      .sort((a,b)=>(a.episode||0)-(b.episode||0));
    const el=document.getElementById('picker-results');
    el.innerHTML=`<div class="picker-item picker-back" onclick="openPickerShow('${esc(showTitle.replace(/'/g,"\'"))}')" style="border-bottom:1px solid var(--border);margin-bottom:4px">
      <span style="color:var(--accent)">‹</span>
      <div class="picker-info"><div class="picker-title" style="color:var(--text2)">← Season ${seasonNum}</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();addSeasonToQueue('${esc(showTitle.replace(/'/g,"\'"))}',${seasonNum})">＋ Season</button>
      </div>
    </div>`+
    eps.map(ep=>`
      <div class="picker-item" onclick='addToQueue("${ep.id}",${JSON.stringify({title:ep.title,duration:ep.duration,season:ep.season,episode:ep.episode,thumb:ep.thumb||null})})'>
        <div class="picker-thumb">${ep.thumb?`<img src="${esc(ep.thumb)}" loading="lazy" onerror="this.style.display='none'"`+'>'  :''}📺</div>
        <div class="picker-info">
          <div class="picker-title">E${String(ep.episode||0).padStart(2,'0')} · ${esc(ep.title)}</div>
          <div class="picker-meta">${fmtDur(ep.duration)}</div>
        </div>
        <span class="picker-add">＋</span>
      </div>`).join('');
    document.getElementById('picker-pagination').innerHTML='';
  }catch(e){console.error(e)}
}

async function addAllEpsToQueue(showTitle){
  const lib=document.getElementById('picker-lib').value;
  let url=`/api/media?page=1&limit=5000&type=episode`;
  if(lib)url+=`&libraryId=${lib}`;
  const d=await API.get(url);
  const eps=d.items.filter(m=>m.title===showTitle&&m.type==='episode')
    .sort((a,b)=>((a.season||0)*1000+(a.episode||0))-((b.season||0)*1000+(b.episode||0)));
  eps.forEach(ep=>addToQueue(ep.id,{title:ep.title,duration:ep.duration,season:ep.season,episode:ep.episode,thumb:ep.thumb||null}));
  notify(`✅ Added all ${eps.length} episodes of ${showTitle}`);
}

async function addSeasonToQueue(showTitle, seasonNum){
  const lib=document.getElementById('picker-lib').value;
  let url=`/api/media?page=1&limit=5000&type=episode`;
  if(lib)url+=`&libraryId=${lib}`;
  const d=await API.get(url);
  const eps=d.items.filter(m=>m.title===showTitle&&m.type==='episode'&&m.season===seasonNum)
    .sort((a,b)=>(a.episode||0)-(b.episode||0));
  eps.forEach(ep=>addToQueue(ep.id,{title:ep.title,duration:ep.duration,season:ep.season,episode:ep.episode,thumb:ep.thumb||null}));
  notify(`✅ Added Season ${seasonNum} (${eps.length} episodes)`);
}

function renderPickerItems(items, pages, page){
  const el=document.getElementById('picker-results');
  el.innerHTML=items.length?items.map(m=>`
    <div class="picker-item" onclick='addToQueue("${m.id}",${JSON.stringify({title:m.title,duration:m.duration,season:m.season,episode:m.episode,thumb:m.thumb||null})})'>
      <div class="picker-thumb">${m.thumb?`<img src="${esc(m.thumb)}" loading="lazy" onerror="this.style.display='none'"`+'>'  :''}${m.type==='movie'?'🎬':'📺'}</div>
      <div class="picker-info">
        <div class="picker-title">${esc(m.title)}</div>
        <div class="picker-meta">${m.season?`S${String(m.season).padStart(2,'0')}E${String(m.episode||0).padStart(2,'0')} · `:''}${fmtDur(m.duration)}</div>
      </div>
      <span class="picker-add">＋</span>
    </div>`).join(''):'<div style="text-align:center;padding:20px;color:var(--text3);font-size:.85rem">No media found</div>';
  document.getElementById('picker-pagination').innerHTML=pages>1?Array.from({length:Math.min(pages,8)},(_,i)=>{const p=i+1;return`<button class="page-btn${p===page?' active':''}" onclick="loadPickerMedia(${p})">${p}</button>`}).join(''):'';
}

document.getElementById('picker-search').addEventListener('input',()=>loadPickerMedia(1));
document.getElementById('picker-lib').addEventListener('change',()=>loadPickerMedia(1));
document.getElementById('picker-type').addEventListener('change',()=>loadPickerMedia(1));

// ── Schedule ──────────────────────────────────────────────────────────────────
function initSchedule(){
  const d=document.getElementById('schedule-date');
  if(!d.value)d.value=new Date().toISOString().slice(0,10);
  loadSchedule();
}
async function loadSchedule(){
  const date=document.getElementById('schedule-date').value;
  document.getElementById('schedule-sub').textContent=new Date(date+'T12:00:00').toDateString();
  try{
    const schedule=await API.get('/api/schedule?date='+date);
    const now=Date.now();
    document.getElementById('epg-timeline').innerHTML=Array.from({length:24},(_,h)=>{const l=h===0?'12 AM':h<12?`${h} AM`:h===12?'12 PM':`${h-12} PM`;return`<div class="epg-time-slot">${l}</div>`}).join('');
    const ds=new Date(date+'T00:00:00Z').getTime();
    document.getElementById('epg-rows').innerHTML=schedule.length
      ?schedule.map(row=>{
          const ch=row.channel;
          const slots=Array.from({length:24},(_,h)=>{
            const ss=ds+h*3600000,se=ss+3600000,isNow=now>=ss&&now<se;
            const prog=row.programs.find(p=>p.start<se&&p.end>ss);
            if(prog)return`<div class="epg-prog${isNow?' now':''}" title="${esc(prog.title)}"><div class="epg-prog-title">${esc(prog.title)}</div><div class="epg-prog-time">${fmtTime(prog.start)}</div></div>`;
            return`<div class="epg-prog" style="background:var(--bg3)"><div class="epg-prog-title" style="color:var(--text3)">—</div><div class="epg-prog-time">${fmtTime(ss)}</div></div>`;
          }).join('');
          return`<div class="epg-row"><div class="epg-ch-label"><span class="epg-ch-num">${ch.num}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ch.name)}</span></div><div class="epg-programs">${slots}</div></div>`;
        }).join('')
      :'<div class="empty-state"><div class="empty-icon">📺</div><div class="empty-text">No channels with playout configured.</div></div>';
  }catch(e){console.error(e)}
}
document.getElementById('schedule-date').addEventListener('input',loadSchedule);
document.getElementById('btn-today').addEventListener('click',()=>{document.getElementById('schedule-date').value=new Date().toISOString().slice(0,10);loadSchedule()});

// ── Output ────────────────────────────────────────────────────────────────────
async function loadOutput(){
  try{const cfg=await API.get('/api/config');setOutputUrls(cfg.baseUrl||window.location.origin)}
  catch{setOutputUrls(window.location.origin)}
  loadXmltvPreview();
}
function setOutputUrls(base){
  document.getElementById('out-m3u').value=base+'/iptv.m3u';
  document.getElementById('out-xmltv').value=base+'/xmltv.xml';
}
async function loadXmltvPreview(){
  try{const r=await fetch('/xmltv.xml');const t=await r.text();document.getElementById('xmltv-preview').textContent=t.slice(0,3000)+(t.length>3000?'\n...(truncated)':'')}
  catch{document.getElementById('xmltv-preview').textContent='Error loading preview'}
}
document.getElementById('btn-refresh-xmltv').addEventListener('click',loadXmltvPreview);

// ── Setup pages (Plex / Jellyfin) ─────────────────────────────────────────────
async function loadSetupUrls(){
  try{
    const cfg=await API.get('/api/config');
    const base=cfg.baseUrl||window.location.origin;
    ['plex-m3u-url','jf-m3u-url'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=base+'/iptv.m3u'});
    ['plex-xmltv-url','jf-xmltv-url'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=base+'/xmltv.xml'});
  }catch{}
}

// ── Settings ──────────────────────────────────────────────────────────────────
let selectedHwAccel = 'auto';
const toggleStates = {};

function toggleSetting(id) {
  const el = document.getElementById(id);
  const sw = el?.querySelector('.toggle-switch');
  if (!sw) return;
  sw.classList.toggle('active');
  toggleStates[id] = sw.classList.contains('active');
}

function setToggle(id, val) {
  const el = document.getElementById(id);
  const sw = el?.querySelector('.toggle-switch');
  if (!sw) return;
  sw.classList.toggle('active', !!val);
  toggleStates[id] = !!val;
}

function getToggle(id) {
  return toggleStates[id] !== undefined ? toggleStates[id] : document.getElementById(id)?.querySelector('.toggle-switch')?.classList.contains('active');
}

function setSelect(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  // Find matching option, fallback to first
  const opt = [...el.options].find(o => o.value === String(val));
  if (opt) el.value = val;
}

async function loadSettings(){
  try{
    const [cfg,status]=await Promise.all([API.get('/api/config'),API.get('/api/status')]);

    // General
    document.getElementById('cfg-baseurl').value = cfg.baseUrl||'';

    // AI provider
    const provider = cfg.aiProvider || 'anthropic';
    selectAiProvider(provider);
    // Anthropic
    const anthKeyEl = document.getElementById('cfg-anthropic-key'); if(anthKeyEl) anthKeyEl.value = cfg.anthropicApiKey||'';
    const anthModEl = document.getElementById('cfg-anthropic-model'); if(anthModEl && cfg.anthropicModel) setSelect('cfg-anthropic-model', cfg.anthropicModel);
    // OpenAI
    const oaiKeyEl = document.getElementById('cfg-openai-key'); if(oaiKeyEl) oaiKeyEl.value = cfg.openaiApiKey||'';
    setSelect('cfg-openai-model', cfg.openaiModel||'gpt-4o');
    // Open WebUI
    const owuiUrlEl = document.getElementById('cfg-owui-url'); if(owuiUrlEl) owuiUrlEl.value = cfg.openwebUIUrl||'';
    const owuiKeyEl = document.getElementById('cfg-owui-key'); if(owuiKeyEl) owuiKeyEl.value = cfg.openwebUIKey||'';
    if(cfg.openwebUIModel){const s=document.getElementById('cfg-owui-model');if(s){const o=document.createElement('option');o.value=cfg.openwebUIModel;o.textContent=cfg.openwebUIModel;o.selected=true;s.insertBefore(o,s.firstChild);s.value=cfg.openwebUIModel;}}
    // Ollama
    const olUrlEl = document.getElementById('cfg-ollama-url'); if(olUrlEl) olUrlEl.value = cfg.ollamaUrl||'http://localhost:11434/v1';
    if(cfg.ollamaModel){const s=document.getElementById('cfg-ollama-model');if(s){const o=document.createElement('option');o.value=cfg.ollamaModel;o.textContent=cfg.ollamaModel;o.selected=true;s.insertBefore(o,s.firstChild);s.value=cfg.ollamaModel;}}
    // Custom
    const cusUrlEl = document.getElementById('cfg-custom-url'); if(cusUrlEl) cusUrlEl.value = cfg.customAiUrl||'';
    const cusKeyEl = document.getElementById('cfg-custom-key'); if(cusKeyEl) cusKeyEl.value = cfg.customAiKey||'';
    const cusModEl = document.getElementById('cfg-custom-model-input'); if(cusModEl) cusModEl.value = cfg.customAiModel||'';
    document.getElementById('cfg-days').value    = cfg.epgDaysAhead||7;

    // FFmpeg
    document.getElementById('cfg-ffmpeg').value  = status.ffmpegPath||cfg.ffmpegPath||'/usr/bin/ffmpeg';
    document.getElementById('cfg-ffprobe').value = status.ffprobePath||cfg.ffprobePath||'/usr/bin/ffprobe';
    const ok = status.ffmpeg;
    document.getElementById('ffmpeg-status').innerHTML = ok
      ? `<span style="color:var(--success)">✓ FFmpeg found at ${esc(status.ffmpegPath||'')}</span>`
      : `<span style="color:var(--accent2)">✗ FFmpeg not found — run: apt-get install -y ffmpeg</span>`;
    const ffEl = document.getElementById('stat-ffmpeg');
    if (ffEl) { ffEl.textContent=ok?'✓ Ready':'✗ Missing'; ffEl.style.color=ok?'var(--success)':'var(--accent2)'; }

    // Hardware acceleration
    selectedHwAccel = cfg.hwAccel || 'auto';

    // Video
    setSelect('cfg-vcodec',   cfg.videoCodec    || 'copy');
    setSelect('cfg-vres',     cfg.videoResolution|| 'source');
    setSelect('cfg-vbitrate', cfg.videoBitrate   || '4M');
    setSelect('cfg-vpreset',  cfg.videoPreset    || 'p4');
    const crfEl = document.getElementById('cfg-crf');
    if (crfEl) { crfEl.value = cfg.videoCrf || 23; document.getElementById('cfg-crf-val').textContent = crfEl.value; }

    // Audio
    setSelect('cfg-acodec',    cfg.audioCodec    || 'aac');
    setSelect('cfg-abitrate',  cfg.audioBitrate  || '192k');
    setSelect('cfg-achannels', String(cfg.audioChannels || 2));
    setSelect('cfg-alang',     cfg.audioLanguage || 'any');
    setToggle('toggle-normalize', cfg.normalizeAudio !== false);

    // HLS
    const hsg = document.getElementById('cfg-hlsseg');  if(hsg) hsg.value = cfg.hlsSegmentSeconds||4;
    const hls = document.getElementById('cfg-hlslist'); if(hls) hls.value = cfg.hlsListSize||6;
    const hli = document.getElementById('cfg-hlsidle'); if(hli) hli.value = cfg.hlsIdleTimeoutSecs||60;
    setSelect('cfg-hlsfmt', cfg.hlsOutputFormat||'mpegts');

    await probeHardware();
  }catch(e){console.error('loadSettings',e)}
}

async function probeHardware(){
  const el=document.getElementById('hw-options');
  if(!el)return;
  el.innerHTML='<div class="hw-option-loading">Detecting hardware...</div>';
  try{
    const data=await API.get('/api/hw-probe');
    selectedHwAccel=data.current||'auto';
    renderHwOptions(data.options, data.current);
  }catch(e){
    el.innerHTML='<div class="hw-option-loading" style="color:var(--accent2)">Failed to probe hardware</div>';
  }
}

function renderHwOptions(options, current){
  const el=document.getElementById('hw-options');
  if(!el)return;

  const icons={'software':'💻','nvenc':'🎮','vaapi':'🔷','auto':'⚡','videotoolbox':'🍎'};
  const extraNote={'auto':'Let StreamForge choose the best available option'};

  // Add auto option at top
  const allOpts=[{id:'auto',label:'Auto Detect',available:true,note:extraNote['auto']},...options];

  el.innerHTML=allOpts.map(opt=>{
    const isSelected=(current===opt.id)||(current==='auto'&&opt.id==='auto');
    const icon=icons[opt.id]||'⚙️';
    return `<div class="hw-option${isSelected?' selected':''}${!opt.available?' unavailable':''}"
      onclick="${opt.available?`selectHw('${opt.id}')`:''}"
      data-hw="${opt.id}">
      <div class="hw-option-radio"></div>
      <div class="hw-option-icon">${icon}</div>
      <div class="hw-option-info">
        <div class="hw-option-label">${esc(opt.label)}</div>
        <div class="hw-option-note">${esc(opt.note||'')}</div>
      </div>
      <span class="hw-option-badge ${opt.available?'hw-badge-ok':'hw-badge-na'}">${opt.available?'Available':'Not Available'}</span>
    </div>`;
  }).join('');
}

function selectHw(id){
  selectedHwAccel=id;
  document.querySelectorAll('.hw-option').forEach(el=>{
    el.classList.toggle('selected', el.dataset.hw===id);
  });
}
document.getElementById('btn-save-config').addEventListener('click',async()=>{
  try{
    await API.put('/api/config',{
      // General
      baseUrl:      document.getElementById('cfg-baseurl').value.trim(),
      epgDaysAhead: parseInt(document.getElementById('cfg-days').value),
      // FFmpeg
      ffmpegPath:   document.getElementById('cfg-ffmpeg').value.trim(),
      ffprobePath:  document.getElementById('cfg-ffprobe').value.trim(),
      // HW accel
      hwAccel: selectedHwAccel || 'auto',
      // Video
      videoCodec:       document.getElementById('cfg-vcodec').value,
      videoResolution:  document.getElementById('cfg-vres').value,
      videoBitrate:     document.getElementById('cfg-vbitrate').value,
      videoMaxBitrate:  document.getElementById('cfg-vbitrate').value.replace(/\d+/, v => String(parseInt(v)*2)),
      videoBufferSize:  document.getElementById('cfg-vbitrate').value.replace(/\d+/, v => String(parseInt(v)*2)),
      videoCrf:         parseInt(document.getElementById('cfg-crf').value),
      videoPreset:      document.getElementById('cfg-vpreset').value,
      // Audio
      audioCodec:     document.getElementById('cfg-acodec').value,
      audioBitrate:   document.getElementById('cfg-abitrate').value,
      audioChannels:  parseInt(document.getElementById('cfg-achannels').value),
      audioLanguage:  document.getElementById('cfg-alang').value,
      normalizeAudio: getToggle('toggle-normalize'),
      // HLS
      hlsSegmentSeconds:  parseInt(document.getElementById('cfg-hlsseg').value)||4,
      hlsListSize:        parseInt(document.getElementById('cfg-hlslist').value)||6,
      hlsIdleTimeoutSecs: parseInt(document.getElementById('cfg-hlsidle').value)||60,
      hlsOutputFormat:    document.getElementById('cfg-hlsfmt').value,
      aiProvider:       document.querySelector('.ai-provider-card.active[data-provider]')?.dataset?.provider || 'anthropic',
      anthropicApiKey:  (document.getElementById('cfg-anthropic-key')?.value||'').trim(),
      openaiApiKey:     (document.getElementById('cfg-openai-key')?.value||'').trim(),
      openaiModel:      (document.getElementById('cfg-openai-model')?.value||'').trim(),
      openwebUIUrl:     (document.getElementById('cfg-owui-url')?.value||'').trim(),
      openwebUIKey:     (document.getElementById('cfg-owui-key')?.value||'').trim(),
      openwebUIModel:   (document.getElementById('cfg-owui-model')?.value||'').trim(),
      ollamaUrl:        (document.getElementById('cfg-ollama-url')?.value||'').trim(),
      ollamaModel:      (document.getElementById('cfg-ollama-model')?.value||document.getElementById('cfg-ollama-model-input')?.value||'').trim(),
      customAiUrl:      (document.getElementById('cfg-custom-url')?.value||'').trim(),
      customAiKey:      (document.getElementById('cfg-custom-key')?.value||'').trim(),
      customAiModel:    (document.getElementById('cfg-custom-model-input')?.value||'').trim(),
    });
    notify('✅ Settings saved');
    checkStatus();
  }catch{notify('Save failed',true)}
});

document.getElementById('btn-hw-probe').addEventListener('click', probeHardware);
document.getElementById('btn-import-config').addEventListener('change',async e=>{
  if(!e.target.files[0])return;
  const fd=new FormData();fd.append('file',e.target.files[0]);
  try{const r=await API.upload('/api/import',fd);if(r.error){notify(r.error,true);return}notify('✅ Config imported');loadDashboard();checkStatus()}
  catch{notify('Import failed',true)}
});

// ── Button wiring ─────────────────────────────────────────────────────────────
document.getElementById('btn-add-library').addEventListener('click',()=>openModal('modal-library'));
document.getElementById('btn-add-library-2').addEventListener('click',()=>openModal('modal-library'));
document.getElementById('btn-add-channel').addEventListener('click',()=>{editingChId=null;openModal('modal-channel')});
document.getElementById('btn-add-channel-2').addEventListener('click',()=>{editingChId=null;openModal('modal-channel')});
document.getElementById('btn-save-channel').addEventListener('click',saveChannel);


// Auto-fill library name when section/library selection changes
document.getElementById('lib-plex-section').addEventListener('change',function(){
  const nameEl=document.getElementById('lib-name');
  const opt=this.options[this.selectedIndex];
  if(opt&&!nameEl.value)nameEl.value=opt.text.split(' (')[0];
});
document.getElementById('lib-jf-library').addEventListener('change',function(){
  const nameEl=document.getElementById('lib-name');
  const opt=this.options[this.selectedIndex];
  if(opt&&!nameEl.value)nameEl.value=opt.text.split(' (')[0];
});

// ── Watch Page ────────────────────────────────────────────────────────────────
let hls = null;
let watchChannelId = null;
let watchPollTimer = null;
let watchChRefreshTimer = null;

async function loadWatch() {
  await loadWatchChannelList();
}

async function loadWatchChannelList() {
  try {
    const chs = await API.get('/api/channels');
    const el = document.getElementById('watch-ch-list');
    if (!chs.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📺</div><div class="empty-text">No channels yet</div></div>';
      return;
    }
    // Fetch now-playing for all channels in parallel
    const nowAll = await Promise.all(
      chs.filter(c => c.active).map(async ch => {
        try { return { ch, np: await API.get(`/api/channels/${ch.id}/now-playing`) }; }
        catch { return { ch, np: { item: null } }; }
      })
    );
    el.innerHTML = nowAll.map(({ ch, np }) => `
      <div class="watch-ch-item${watchChannelId === ch.id ? ' active' : ''}" onclick="tuneToChannel('${ch.id}')" id="watch-ch-item-${ch.id}">
        <span class="watch-ch-item-num">${ch.num}</span>
        <div class="watch-ch-item-info">
          <div class="watch-ch-item-name">${esc(ch.name)}</div>
          <div class="watch-ch-item-prog">${np.item ? esc(np.item.title) : 'Nothing scheduled'}</div>
        </div>
        ${np.item ? '<span class="watch-ch-item-live">LIVE</span>' : ''}
      </div>`).join('');
  } catch (e) { console.error('Watch channel list', e); }
}

async function tuneToChannel(channelId) {
  // Update active state in list
  document.querySelectorAll('.watch-ch-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById('watch-ch-item-' + channelId);
  if (item) item.classList.add('active');

  // Stop previous session
  if (watchChannelId && watchChannelId !== channelId) {
    await API.del('/api/channels/' + watchChannelId + '/watch').catch(() => {});
  }
  if (hls) { hls.destroy(); hls = null; }
  clearInterval(watchPollTimer);

  watchChannelId = channelId;
  const overlay = document.getElementById('watch-overlay');
  const msg = document.getElementById('watch-overlay-msg');
  const bar  = document.getElementById('watch-player-bar');
  overlay.classList.remove('hidden');
  msg.textContent = 'Starting stream...';
  bar.style.display = 'none';

  try {
    // Start HLS session on server
    const r = await API.post('/api/channels/' + channelId + '/watch', {});
    if (r.error) { msg.textContent = 'Error: ' + r.error; return; }

    const video = document.getElementById('watch-video');
    const hlsUrl = r.hlsUrl;

    if (Hls.isSupported()) {
      hls = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        lowLatencyMode: false,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        overlay.classList.add('hidden');
        bar.style.display = 'flex';
        // Try unmuted first — works in most browsers on local network
        video.muted = false;
        video.volume = 1;
        video.play().then(() => {
          // Playing with audio — perfect
          updateMuteBtn();
        }).catch(() => {
          // Autoplay blocked — try muted fallback
          video.muted = true;
          video.play().then(() => {
            // Playing muted — show prominent unmute button
            updateMuteBtn();
            // Show unmute prompt in overlay briefly
            overlay.classList.remove('hidden');
            msg.textContent = '🔇 Click to unmute';
            overlay.style.cursor = 'pointer';
            overlay.onclick = () => {
              video.muted = false;
              video.volume = 1;
              overlay.classList.add('hidden');
              overlay.style.cursor = '';
              overlay.onclick = null;
              updateMuteBtn();
            };
          }).catch(() => {
            overlay.classList.remove('hidden');
            msg.textContent = '▶ Click to play';
            overlay.style.cursor = 'pointer';
            overlay.onclick = () => {
              video.muted = false;
              video.volume = 1;
              video.play();
              overlay.classList.add('hidden');
              overlay.style.cursor = '';
              overlay.onclick = null;
              updateMuteBtn();
            };
          });
        });
      });
      let retryCount = 0;
      hls.on(Hls.Events.ERROR, async (_, data) => {
        if (data.fatal) {
          retryCount++;
          overlay.classList.remove('hidden');
          bar.style.display = 'none';
          if (retryCount > 3) {
            // Too many retries — stop and show error
            msg.textContent = '⚠ Stream failed after multiple retries. Check Settings.';
            hls.destroy();
            hls = null;
            return;
          }
          msg.textContent = `Stream error — retrying (${retryCount}/3)...`;
          try {
            // Tell server to kill and restart the FFmpeg session
            await API.del('/api/channels/' + channelId + '/watch');
          } catch (_) {}
          setTimeout(() => tuneToChannel(channelId), 4000);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', () => {
        overlay.classList.add('hidden');
        bar.style.display = 'flex';
        video.play();
      });
    } else {
      msg.textContent = 'HLS not supported in this browser';
      return;
    }

    // Update now-playing info
    await updateNowPlaying(channelId);
    // Poll every 15s to refresh now-playing
    watchPollTimer = setInterval(() => updateNowPlaying(channelId), 15000);

  } catch (e) {
    msg.textContent = 'Failed to start stream: ' + e.message;
    console.error(e);
  }
}

async function updateNowPlaying(channelId) {
  try {
    const np = await API.get('/api/channels/' + channelId + '/now-playing');
    const ch = (await API.get('/api/channels')).find(c => c.id === channelId);
    if (!np.item) return;

    document.getElementById('watch-ch-num').textContent = ch ? `CH ${ch.num}` : '';
    document.getElementById('watch-now-title').textContent = np.item.title || '';
    document.getElementById('watch-now-meta').textContent =
      np.item.season
        ? `S${String(np.item.season).padStart(2,'0')}E${String(np.item.episode||0).padStart(2,'0')} · ${fmtDur(np.item.duration)}`
        : fmtDur(np.item.duration);

    // Detail card
    document.getElementById('watch-detail-title').textContent = np.item.title || '';
    document.getElementById('watch-detail-meta').textContent =
      np.item.season
        ? `Season ${np.item.season}, Episode ${np.item.episode} · ${np.item.year || ''}`
        : np.item.year || '';
    document.getElementById('watch-detail-desc').textContent = np.item.summary || '';
    const thumb = document.getElementById('watch-thumb');
    if (np.item.thumb) { thumb.src = np.item.thumb; thumb.style.display = 'block'; }
    else { thumb.style.display = 'none'; }

    // Up next — get today's schedule for this channel
    const today = new Date().toISOString().slice(0,10);
    const schedule = await API.get('/api/schedule?date=' + today);
    const chSchedule = schedule.find(r => r.channel.id === channelId);
    if (chSchedule) {
      const upcoming = chSchedule.programs
        .filter(p => p.start > Date.now())
        .slice(0, 5);
      document.getElementById('watch-up-next').innerHTML = upcoming.length
        ? upcoming.map(p => `
            <div class="watch-up-next-item">
              <span class="watch-up-next-time">${fmtTime(p.start)}</span>
              <span class="watch-up-next-title">${esc(p.title)}</span>
            </div>`).join('')
        : '<div style="padding:14px 16px;color:var(--text3);font-size:.84rem">No upcoming schedule</div>';
    }
  } catch (e) { console.error('updateNowPlaying', e); }
}

function updateMuteBtn() {
  const video = document.getElementById('watch-video');
  const btn   = document.getElementById('watch-mute-btn');
  if (!btn) return;
  btn.textContent = video.muted ? '🔇 Unmute' : '🔊 Mute';
}

function toggleMute() {
  const video = document.getElementById('watch-video');
  video.muted = !video.muted;
  updateMuteBtn();
}

function toggleFullscreen() {
  const wrap = document.getElementById('watch-player-wrap');
  if (!document.fullscreenElement) {
    wrap.requestFullscreen().catch(() => {});
    document.getElementById('watch-fullscreen-btn').textContent = '✕ Exit';
  } else {
    document.exitFullscreen();
    document.getElementById('watch-fullscreen-btn').textContent = '⛶ Fullscreen';
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement)
    document.getElementById('watch-fullscreen-btn').textContent = '⛶ Fullscreen';
});

// Keep mute button in sync when user uses native video controls
document.getElementById('watch-video').addEventListener('volumechange', updateMuteBtn);

// Stop stream when leaving watch page
document.querySelectorAll('.nav-item[data-page]').forEach(el => {
  el.addEventListener('click', () => {
    if (el.dataset.page !== 'watch' && watchChannelId) {
      if (hls) { hls.destroy(); hls = null; }
      API.del('/api/channels/' + watchChannelId + '/watch').catch(() => {});
      watchChannelId = null;
      clearInterval(watchPollTimer);
      document.getElementById('watch-overlay').classList.remove('hidden');
      document.getElementById('watch-overlay-msg').textContent = 'Select a channel to watch';
      document.getElementById('watch-player-bar').style.display = 'none';
    }
  });
});


// ── EPG Import ────────────────────────────────────────────────────────────────
let epgData = { channels: [], programs: [] };
let aiSuggestions = [];

async function loadEpgImport() {
  try {
    const d = await API.get('/api/epg');
    const statusEl = document.getElementById('epg-import-status');
    const clearBtn = document.getElementById('btn-clear-epg');
    if (d.channelCount > 0) {
      statusEl.innerHTML = `<div class="card" style="background:rgba(0,230,118,.05);border-color:var(--success);padding:14px 20px">
        <span style="color:var(--success);font-weight:600">✓ EPG Loaded:</span>
        <span style="color:var(--text2);margin-left:8px">${d.sourceName}</span>
        <span style="color:var(--text3);margin-left:12px">${d.channelCount} channels · ${d.programCount} programs · imported ${new Date(d.importedAt).toLocaleString()}</span>
      </div>`;
      clearBtn.style.display = '';
    } else {
      statusEl.innerHTML = '';
      clearBtn.style.display = 'none';
    }
  } catch {}
}

document.getElementById('btn-import-epg-url').addEventListener('click', async () => {
  const url = document.getElementById('epg-url').value.trim();
  if (!url) { notify('Enter an XMLTV URL', true); return; }
  const btn = document.getElementById('btn-import-epg-url');
  btn.textContent = 'Importing...'; btn.disabled = true;
  try {
    const r = await API.post('/api/epg/import', { url });
    if (r.error) { notify('Import error: ' + r.error, true); return; }
    notify(`✅ EPG imported — ${r.channelCount} channels, ${r.programCount} programs`);
    loadEpgImport();
  } catch(e) { notify('Failed: ' + e.message, true); }
  finally { btn.textContent = '⬇ Fetch & Import'; btn.disabled = false; }
});

document.getElementById('btn-import-epg-file').addEventListener('click', async () => {
  const fileInput = document.getElementById('epg-file-input');
  if (!fileInput.files[0]) { notify('Select a file first', true); return; }
  const btn = document.getElementById('btn-import-epg-file');
  btn.textContent = 'Uploading...'; btn.disabled = true;
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  try {
    const r = await API.upload('/api/epg/import', fd);
    if (r.error) { notify('Import error: ' + r.error, true); return; }
    notify(`✅ EPG imported — ${r.channelCount} channels, ${r.programCount} programs`);
    loadEpgImport();
  } catch(e) { notify('Failed: ' + e.message, true); }
  finally { btn.textContent = '⬆ Upload & Import'; btn.disabled = false; }
});

document.getElementById('btn-clear-epg').addEventListener('click', async () => {
  if (!confirm('Clear all imported EPG data?')) return;
  await API.del('/api/epg');
  notify('EPG cleared');
  loadEpgImport();
});

// ── EPG Browser ───────────────────────────────────────────────────────────────
async function loadEpgBrowser() {
  const dateEl = document.getElementById('epg-browser-date');
  if (!dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

  try {
    const d = await API.get('/api/epg');
    if (!d.channelCount) {
      document.getElementById('epg-browser-content').innerHTML =
        '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No EPG imported yet. Go to EPG Import first.</div></div>';
      return;
    }
    epgData.channels = d.channels;
    document.getElementById('epg-browser-sub').textContent = `${d.sourceName} — ${d.channelCount} channels`;
    renderEpgChannelList(d.channels, '');
  } catch(e) { console.error(e); }
}

function renderEpgChannelList(channels, filter) {
  const filtered = filter
    ? channels.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()) || c.id.toLowerCase().includes(filter.toLowerCase()))
    : channels;

  const el = document.getElementById('epg-browser-content');
  if (!filtered.length) { el.innerHTML = '<div class="empty-state"><div class="empty-text">No channels match</div></div>'; return; }

  el.innerHTML = `<div class="epg-ch-grid">${filtered.map(ch => `
    <div class="epg-ch-card" onclick="openEpgChannel('${esc(ch.id)}','${esc(ch.name.replace(/'/g,"'"))}')">
      ${ch.icon ? `<img src="${esc(ch.icon)}" class="epg-ch-logo" onerror="this.style.display='none'" alt="">` : '<div class="epg-ch-logo-placeholder">📺</div>'}
      <div class="epg-ch-card-name">${esc(ch.name)}</div>
      <div class="epg-ch-card-id">${esc(ch.id)}</div>
    </div>`).join('')}</div>`;
}

async function openEpgChannel(channelId, channelName) {
  const date = document.getElementById('epg-browser-date').value;
  const el = document.getElementById('epg-browser-content');
  el.innerHTML = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:12px">
    <button class="btn btn-secondary btn-sm" onclick="loadEpgBrowser()">← All Channels</button>
    <span style="font-weight:600;color:var(--text)">${esc(channelName)}</span>
    <button class="btn btn-primary btn-sm" onclick="goToAiScheduler('${channelId}')">🤖 Build Schedule from This Channel</button>
  </div><div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Loading programs...</div></div>`;

  try {
    const programs = await API.get(`/api/epg/programs?channelId=${encodeURIComponent(channelId)}&date=${date}&limit=100`);
    if (!programs.length) {
      el.innerHTML += ''; // keep header
      document.querySelector('#epg-browser-content .empty-state .empty-text').textContent = 'No programs found for this date';
      return;
    }

    const header = el.querySelector('div');
    el.innerHTML = '';
    el.appendChild(header);

    const table = document.createElement('div');
    table.className = 'card';
    table.innerHTML = programs.map(p => `
      <div style="display:flex;align-items:flex-start;gap:14px;padding:12px 18px;border-bottom:1px solid var(--border)">
        <div style="font-family:'Space Mono',monospace;font-size:.72rem;color:var(--accent);min-width:90px;padding-top:2px">
          ${new Date(p.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}–${new Date(p.stop).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
        </div>
        <div style="flex:1">
          <div style="font-weight:600;color:var(--text);font-size:.9rem">${esc(p.title)}</div>
          ${p.category ? `<div style="font-size:.74rem;color:var(--accent3);margin:2px 0">${esc(p.category)}</div>` : ''}
          ${p.desc ? `<div style="font-size:.8rem;color:var(--text2);margin-top:3px;line-height:1.5">${esc(p.desc.slice(0,200))}${p.desc.length>200?'…':''}</div>` : ''}
        </div>
        <div style="font-family:'Space Mono',monospace;font-size:.68rem;color:var(--text3);white-space:nowrap">
          ${Math.round((p.stop - p.start)/60000)}min
        </div>
      </div>`).join('');
    el.appendChild(table);
  } catch(e) { console.error(e); }
}

document.getElementById('epg-ch-search').addEventListener('input', e => {
  renderEpgChannelList(epgData.channels, e.target.value);
});
document.getElementById('epg-browser-date').addEventListener('change', loadEpgBrowser);
document.getElementById('btn-epg-today').addEventListener('click', () => {
  document.getElementById('epg-browser-date').value = new Date().toISOString().slice(0,10);
  loadEpgBrowser();
});

// ── AI Scheduler ──────────────────────────────────────────────────────────────
async function loadAiScheduler() {
  // Populate EPG channel dropdown
  try {
    const d = await API.get('/api/epg');
    const sel = document.getElementById('ai-epg-channel');
    if (d.channels.length) {
      sel.innerHTML = '<option value="">— Select an EPG channel —</option>' +
        d.channels.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    } else {
      sel.innerHTML = '<option value="">— Import EPG first —</option>';
    }
    const dateEl = document.getElementById('ai-epg-date');
    if (!dateEl.value) dateEl.value = new Date().toISOString().slice(0,10);
  } catch {}

  // Populate target channel dropdown
  try {
    const chs = await API.get('/api/channels');
    const sel = document.getElementById('ai-target-channel');
    sel.innerHTML = '<option value="">— Select a channel —</option>' +
      chs.map(c => `<option value="${c.id}">${c.num} — ${esc(c.name)}</option>`).join('');
  } catch {}
}

function goToAiScheduler(epgChannelId) {
  showPage('ai-scheduler');
  setTimeout(() => {
    const sel = document.getElementById('ai-epg-channel');
    if (sel) sel.value = epgChannelId;
  }, 300);
}

document.getElementById('btn-ai-build').addEventListener('click', async () => {
  const channelId  = document.getElementById('ai-epg-channel').value;
  const date       = document.getElementById('ai-epg-date').value;
  const userPrompt = document.getElementById('ai-prompt').value.trim();
  const targetCh   = document.getElementById('ai-target-channel').value;

  if (!channelId) { notify('Select an EPG channel first', true); return; }

  const btn = document.getElementById('btn-ai-build');
  btn.textContent = '🤖 AI is thinking...'; btn.disabled = true;

  const resultsEl = document.getElementById('ai-results');
  resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🤖</div><div class="empty-text">Analysing EPG and matching your library...</div></div>';

  try {
    const r = await API.post('/api/ai/build-schedule', { channelId, date, userPrompt, targetChannelId: targetCh });
    if (r.error) { notify('AI error: ' + r.error, true); resultsEl.innerHTML = `<div style="padding:20px;color:var(--accent2)">${esc(r.error)}</div>`; return; }

    aiSuggestions = r.suggestions || [];
    document.getElementById('ai-results-badge').textContent = `${aiSuggestions.length} matches from ${r.programCount} EPG programs`;

    // Render reasoning
    let html = '';
    if (r.reasoning) {
      html += `<div style="padding:14px 20px;border-bottom:1px solid var(--border);background:rgba(0,229,255,.04)">
        <div style="font-size:.75rem;color:var(--accent);font-family:'Space Mono',monospace;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">AI Reasoning</div>
        <div style="font-size:.86rem;color:var(--text2);line-height:1.6">${esc(r.reasoning)}</div>
      </div>`;
    }

    // Render suggestions
    html += aiSuggestions.map((s, i) => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid var(--border)">
        <span style="font-family:'Space Mono',monospace;font-size:.7rem;color:var(--text3);min-width:24px">${i+1}</span>
        ${s.item?.thumb ? `<img src="${esc(s.item.thumb)}" style="width:36px;height:52px;object-fit:cover;border-radius:3px;flex-shrink:0" onerror="this.style.display='none'" alt="">` : '<div style="width:36px;height:52px;background:var(--bg3);border-radius:3px;flex-shrink:0;display:flex;align-items:center;justify-content:center">📺</div>'}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text);font-size:.88rem">${esc(s.title || s.item?.title || '')}</div>
          <div style="font-size:.76rem;color:var(--text3);margin-top:2px">${s.item?.season ? `S${String(s.item.season).padStart(2,'0')}E${String(s.item.episode||0).padStart(2,'0')} · ` : ''}${fmtDur(s.item?.duration||0)}</div>
          <div style="font-size:.78rem;color:var(--accent3);margin-top:3px;font-style:italic">${esc(s.reason||'')}</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="aiSuggestions.splice(${i},1);renderAiResults()">✕</button>
      </div>`).join('');

    resultsEl.innerHTML = html || '<div style="padding:20px;color:var(--text3)">No matches found</div>';

    // Unmatched
    if (r.unmatchedSlots?.length) {
      document.getElementById('ai-unmatched-card').style.display = '';
      document.getElementById('ai-unmatched').innerHTML = r.unmatchedSlots.map(t => `<span style="display:inline-block;background:var(--bg3);border-radius:4px;padding:2px 8px;margin:2px;font-size:.8rem">${esc(t)}</span>`).join('');
    }

    // Show apply bar
    const addBar = document.getElementById('ai-add-bar');
    if (aiSuggestions.length && targetCh) {
      addBar.style.display = 'flex';
      document.getElementById('ai-add-summary').textContent = `${aiSuggestions.length} items ready to add to channel`;
    }

    notify(`✅ AI found ${aiSuggestions.length} matches`);
  } catch(e) { notify('AI failed: ' + e.message, true); }
  finally { btn.textContent = '🤖 Build Schedule with AI'; btn.disabled = false; }
});

function renderAiResults() {
  // Re-render after removing items
  document.getElementById('ai-results').querySelectorAll('[style*="border-bottom"]').forEach((el, i) => {
    // update index buttons
  });
  document.getElementById('ai-add-summary').textContent = `${aiSuggestions.length} items ready to add to channel`;
}

document.getElementById('btn-ai-apply').addEventListener('click', async () => {
  const targetCh = document.getElementById('ai-target-channel').value;
  if (!targetCh) { notify('Select a target channel first', true); return; }
  if (!aiSuggestions.length) { notify('No suggestions to add', true); return; }

  try {
    // Load current playout and append
    const current = await API.get(`/api/channels/${targetCh}/playout`);
    const newPlayout = [
      ...current.map(b => ({ mediaId: b.mediaId })),
      ...aiSuggestions.map(s => ({ mediaId: s.mediaId })),
    ];
    await API.put(`/api/channels/${targetCh}/playout`, { playout: newPlayout });
    notify(`✅ Added ${aiSuggestions.length} items to channel playout`);
    document.getElementById('ai-add-bar').style.display = 'none';
  } catch(e) { notify('Failed to apply: ' + e.message, true); }
});


// ── AI Provider Settings ──────────────────────────────────────────────────────
const AI_PROVIDERS = ['anthropic','openai','openwebui','ollama','custom'];

function selectAiProvider(provider) {
  document.querySelectorAll('.ai-provider-card[data-provider]').forEach(c =>
    c.classList.toggle('active', c.dataset.provider === provider)
  );
  AI_PROVIDERS.forEach(p => {
    const el = document.getElementById(`ai-fields-${p}`);
    if (el) el.style.display = p === provider ? '' : 'none';
  });
}

document.querySelectorAll('.ai-provider-card[data-provider]').forEach(card => {
  card.addEventListener('click', () => selectAiProvider(card.dataset.provider));
});

// Generic model fetch helper
async function fetchModelsInto(selectId, provider, urlVal, keyVal) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const params = new URLSearchParams({ provider });
  if (urlVal) params.set('url', urlVal);
  if (keyVal) params.set('key', keyVal);
  try {
    const r = await API.get('/api/ai/models?' + params.toString());
    if (r.error) { notify('Could not fetch models: ' + r.error, true); return; }
    if (!r.models?.length) { notify('No models returned — check URL/key', true); return; }
    sel.innerHTML = r.models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    notify(`✅ Found ${r.models.length} models`);
  } catch(e) { notify('Fetch failed: ' + e.message, true); }
}

document.getElementById('btn-fetch-owui-models')?.addEventListener('click', async function() {
  this.textContent = '...'; this.disabled = true;
  await fetchModelsInto('cfg-owui-model', 'openwebui',
    document.getElementById('cfg-owui-url')?.value?.trim(),
    document.getElementById('cfg-owui-key')?.value?.trim()
  );
  this.textContent = '↻ Fetch'; this.disabled = false;
});

document.getElementById('btn-fetch-ollama-models')?.addEventListener('click', async function() {
  this.textContent = '...'; this.disabled = true;
  await fetchModelsInto('cfg-ollama-model', 'ollama',
    document.getElementById('cfg-ollama-url')?.value?.trim(), ''
  );
  this.textContent = '↻ Fetch'; this.disabled = false;
});

document.getElementById('btn-fetch-custom-models')?.addEventListener('click', async function() {
  this.textContent = '...'; this.disabled = true;
  const url = document.getElementById('cfg-custom-url')?.value?.trim();
  const key = document.getElementById('cfg-custom-key')?.value?.trim();
  if (!url) { notify('Enter the API URL first', true); this.textContent = '↻ Fetch'; this.disabled = false; return; }
  // For custom, try to fetch OR let user type manually
  const sel = document.getElementById('cfg-custom-model-input');
  await fetchModelsInto('cfg-custom-model-input', 'custom', url, key);
  this.textContent = '↻ Fetch'; this.disabled = false;
});

// ── Boot ──────────────────────────────────────────────────────────────────────
checkStatus();
loadDashboard();
setInterval(checkStatus,30000);
