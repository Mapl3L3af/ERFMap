/* Icon enhancement preserves each button, its handlers, state and accessible name. */
(() => {
  const paths = {
    upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
    save:'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',
    folder:'M3 7h7l2 2h9l-2 11H3ZM3 7V4h6l3 3h8v2',
    fit:'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6M8 12h8m-4-4v8',
    pan:'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3',
    select:'m5 3 14 9-7 1-3 7Z',
    ruler:'m3 16 13-13 5 5L8 21ZM7 12l3 3m1-7 3 3',
    undo:'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14',
    sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    moon:'M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12',
    plus:'M12 5v14M5 12h14', minus:'M5 12h14',
    close:'m6 6 12 12M6 18 18 6',
    chart:'M4 3v17h17M8 15v-4m5 4V6m5 9V9',
    sliders:'M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6',
    play:'m8 4 12 8-12 8Z',
    layers:'m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    back:'m10 5-7 7 7 7M3 12h18',
    drone:'m8 8 8 8M8 16l8-8M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0m12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0m12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    people:'M9 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0m12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0M1 21v-4a5 5 0 0 1 10 0v4m2 0v-4a5 5 0 0 1 10 0v4',
    info:'M12 11v6m0-10v.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
  };
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','flight-icon');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]);svg.append(path);return svg;
  }
  const ids={import:'upload',save:'save',load:'folder',fit:'fit',pan:'pan',toolbarSelect:'select',distanceTool:'ruler',toolbarUndo:'undo',undo:'undo',undoMark:'undo',lightMode:'sun',darkMode:'moon',plus:'plus',minus:'minus',closeProperties:'close',fold:'close',flat:'back'};
  const tabs={Add:'plus',Analyse:'chart',Simulate:'play',Properties:'sliders'};
  function enhance(button){
    if(!(button instanceof HTMLButtonElement))return;
    const name=ids[button.id] || tabs[button.dataset.tab] || ({fit:'fit',pan:'pan',select:'select'})[button.dataset.map] || button.dataset.icon;
    if(!paths[name] || button.querySelector('.flight-icon'))return;
    const label=button.id==='fold' ? button.textContent.trim() : button.getAttribute('aria-label') || button.title || button.textContent.trim();
    if(!label)return;
    // Re-rendered controls keep their current action labels, including expanded state.
    button.setAttribute('aria-label',label);button.title=label;
    button.replaceChildren(icon(name));button.classList.add('flight-icon-button');
  }
  document.querySelectorAll('button').forEach(enhance);
  const observer=new MutationObserver(records=>{
    const candidates=new Set();
    for(const r of records){
      if(r.target instanceof Element && (r.target.namespaceURI==='http://www.w3.org/2000/svg' || r.target.closest('#map, #crewOverlay')))continue;
      if(r.target instanceof Element && r.target.closest('button'))candidates.add(r.target.closest('button'));
      for(const node of r.addedNodes){
        if(!(node instanceof Element) || node.namespaceURI==='http://www.w3.org/2000/svg')continue;
        if(node.matches('button'))candidates.add(node);
        node.querySelectorAll('button').forEach(b=>candidates.add(b));
      }
    }
    candidates.forEach(enhance);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  const main=document.querySelector('main');
  if(main){if(!main.id)main.id='main-content'; main.tabIndex=-1;const skip=document.createElement('a');skip.className='skip-link';skip.href='#'+main.id;skip.textContent='Skip to workspace';document.body.prepend(skip);}
  // Native disclosure controls: only one menu open, Escape restores trigger focus.
  const menus=document.querySelector('#documentMenus');
  if(menus){
    menus.addEventListener('toggle',event=>{if(event.target.open)menus.querySelectorAll('details[open]').forEach(d=>{if(d!==event.target)d.open=false;});},true);
    document.addEventListener('pointerdown',e=>{if(!menus.contains(e.target))menus.querySelectorAll('details[open]').forEach(d=>d.open=false);});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){const open=menus.querySelector('details[open]');if(open){open.open=false;open.querySelector('summary').focus();}}});
  }
  // Decorative mission glyphs do not replace the names of navigation destinations.
  const sectorIcons=['drone','folder','people','info'];
  document.querySelectorAll('.flight-home nav .label').forEach((label,i)=>label.prepend(icon(sectorIcons[i])));
})();
