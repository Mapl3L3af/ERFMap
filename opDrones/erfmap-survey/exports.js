// All exports capture the current edited scenario, including terrain and review provenance.
function downloadSurveyFile(name, data, type) {
    const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');
    a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
document.addEventListener('click',e=>{
    const command=e.target.closest('[data-command]')?.dataset.command;
    if(!['model','contour-export','ground-import'].includes(command))return;
    try {
        if(command==='ground-import'){$('groundFile').click();return;}
        const lines=scenarioContours(site);
        if(command==='model'){
            const labels=Object.entries(kinds).map(([kind,[label,color,geometry]])=>({kind,label,color,geometry}));
            downloadSurveyFile('erfmap-model.glb',intakeShared.buildGlb({...site,contours:lines,showContours:contours},labels),'model/gltf-binary');
            msg='3D model downloaded with editable survey data. Ground gaps remain unmodeled.';
        }else{
            if(!site.samples.length&&!site.contours?.length)throw Error('Import ground elevations before exporting contours.');
            downloadSurveyFile('erfmap-contours.json',JSON.stringify({format:'erfmap-contours-v1',units:'metres',coordinates:'local-map',datum:site.terrain?.verticalDatum||'Supplied sample datum',source:site.terrain?.source||'Interpolated ground samples',interval_m:site.contourInterval||site.terrain?.interval_m||contourInterval(site),contours:lines},null,2),'application/json');
            msg=lines.length+' contour segments downloaded in local metre coordinates.';
        }
    }catch(error){msg=error.message;}
    render();
});
document.addEventListener('change',async e=>{
    if(e.target.id==='contourInterval'){
        const previous=site.contourInterval;
        try{
            const value=e.target.value===''?undefined:Number(e.target.value);
            if(value!==undefined)contourSegments(site,value);
            site.contourInterval=value;contourCache=new WeakMap();persist();multiplayer.sendSite();msg='Contour spacing updated.';
        }catch(error){site.contourInterval=previous;e.target.value=previous??'';msg=error.message;}
        render();
    }
    if(e.target.id!=='groundFile'||!e.target.files[0])return;
    try{
        const data=JSON.parse(await e.target.files[0].text());
        if(data.format!=='erfmap-ground-grid-v1'||data.units!=='metres'||typeof data.source!=='string'||!data.source.trim())throw Error('Use an erfmap-ground-grid-v1 JSON with metre units and source provenance. See Help for the format.');
        const g=validateGroundGrid(data.groundGrid);
        if(g.origin.some(v=>v<0)||g.origin[0]+(g.heights[0].length-1)*g.step[0]>site.w||g.origin[1]+(g.heights.length-1)*g.step[1]>site.h)throw Error('Ground grid must be registered inside this survey’s local map extent.');
        if(!groundGridFaces(g).length)throw Error('Ground grid has no fully observed cells.');
        const samples=[];
        g.heights.forEach((row,y)=>row.forEach((z,x)=>{if(z!==null)samples.push([g.origin[0]+x*g.step[0],g.origin[1]+y*g.step[1],z]);}));
        const next={...site,groundGrid:g,samples,terrain:{source:data.source,verticalDatum:String(data.datum||'Supplied ground datum'),note:'Registered ground cells only; missing observations are not filled.'},showContours:true};
        delete next.contours;delete next.contourInterval;
        site=next;contours=true;profilePoints=[];contourCache=new WeakMap();
        msg='Ground terrain imported. Contours and 3D now use the same observed cells.';commit();
    }catch(error){msg=error.message;render();}
    e.target.value='';
});
