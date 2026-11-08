const weatherNames={clear:'Clear',overcast:'Overcast',rain:'Rain',fog:'Fog',snow:'Snow'};
function scenarioConditions(){
    const value=site.environment||{};
    return {hour:Number.isFinite(value.hour)?Math.min(23.75,Math.max(0,value.hour)):12,
        weather:Object.hasOwn(weatherNames,value.weather)?value.weather:'clear'};
}
function clockLabel(hour){
    const minutes=Math.round(hour*60),h=Math.floor(minutes/60);
    return String(h).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
}
function environmentControls(){
    const env=scenarioConditions();
    return '<h3>Scenario conditions</h3><label>Time of day · <output id="hourValue">'+clockLabel(env.hour)+'</output><input id="scenarioHour" type="range" min="0" max="23.75" step="0.25" value="'+env.hour+'"></label><label>Weather<select id="scenarioWeather">'+Object.entries(weatherNames).map(([key,name])=>'<option value="'+key+'" '+(key===env.weather?'selected':'')+'>'+name+'</option>').join('')+'</select></label><p class="note">Changing conditions restarts the pedestrians with new routes. Rain favors firm ground, snow favors building entries, and darkness favors lit routes.</p>';
}
function environmentLighting(env){
    const daylight=Math.max(0,Math.sin((env.hour-6)*Math.PI/12));
    const twilight=Math.max(0,1-Math.abs(daylight-.08)*6)*(env.hour>=4&&env.hour<=20?1:0);
    const cloud=env.weather!=='clear';
    const brightness=.25+daylight*(cloud?.57:.75);
    return {brightness,daylight,twilight,fog:env.weather==='fog'?.18:env.weather==='rain'?.65:1,
        tint:[brightness+twilight*.12,brightness,brightness+(.06*(1-daylight))],
        sky:cloud?[.13+daylight*.43,.15+daylight*.44,.18+daylight*.44]:[.10+daylight*.45+twilight*.17,.14+daylight*.62,.23+daylight*.63],
        wet:env.weather==='rain'?.84:1};
}
document.addEventListener('input',e=>{
    if(e.target.id!=='scenarioHour')return;
    site.environment={...scenarioConditions(),hour:+e.target.value};
    $('hourValue').textContent=clockLabel(site.environment.hour);
    if(view3)walk.draw();
});
document.addEventListener('change',e=>{
    if(!['scenarioWeather','scenarioHour'].includes(e.target.id))return;
    if(e.target.id==='scenarioWeather')site.environment={...scenarioConditions(),weather:e.target.value};
    planPedestrians(); time=0; frame=performance.now(); msg='Pedestrian plans updated for these conditions.';
    persist();render();multiplayer.sendSite();
});
