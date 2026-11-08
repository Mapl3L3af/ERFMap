const documentMenus=document.getElementById('documentMenus');
function closeMenus(){documentMenus.querySelectorAll('details[open]').forEach(menu=>menu.open=false);}
documentMenus.querySelectorAll('summary').forEach(summary=>{
    summary.addEventListener('click',()=>{
        documentMenus.querySelectorAll('details').forEach(menu=>{if(menu!==summary.parentElement)menu.open=false;});
    });
});
document.addEventListener('click',e=>{
    const target=e.target.closest('button');
    if(!documentMenus.contains(e.target))closeMenus();
    if(!target)return;
    const command=target.dataset.command;
    if(target.dataset.insert){
        view3=false;tab='Add';folded=false;kind=target.dataset.insert;mode='Draw feature';draft=[];panMode=false;render();
    }else if(target.dataset.openPanel){
        tab=target.dataset.openPanel;folded=false;render();
    }else if(command){
        if(['import','save','fit','plus','minus'].includes(command))$(command).click();
        else if(['contours','measure','textures'].includes(command)){
            const input=$(command==='textures'?'surveyTextures':command);if(!input.disabled){input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}));}
        }else if(command==='exportGlb'){
            exportGlbFile();
        }else if(command==='attachPhoto'){
            $('photoFile').click();
        }else if(command==='undo'){
            if(history.length){site.features=JSON.parse(history.pop());sel=-1;vertexSel=-1;draft=[];commit();}
        }else if(command==='properties'){
            closeMenus();
        }else{
            const nextMode={select:'Select',move:'Move vertex'}[command];
            if(nextMode){
                view3=false;tab='Add';folded=false;panMode=false;draft=[];vertexSel=-1;
                mode=nextMode;render();
            }
        }
    }
    if(command||target.dataset.insert||target.dataset.openPanel)closeMenus();
});
document.addEventListener('keydown',e=>{
    if(e.key==='Escape')closeMenus();
    if(documentMenus.contains(e.target)&&['ArrowDown','ArrowUp'].includes(e.key)){
        const menu=e.target.closest('details');
        if(!menu)return;
        e.preventDefault();menu.open=true;
        const choices=[...menu.querySelectorAll('button')],i=choices.indexOf(document.activeElement);
        choices[(i+(e.key==='ArrowDown'?1:choices.length-1)+choices.length)%choices.length]?.focus();
    }
});
