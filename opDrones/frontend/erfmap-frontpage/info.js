(async()=>{
    const status=document.getElementById('setupStatus'),list=document.getElementById('capabilities');
    try{
        const response=await fetch('/api/intake/capabilities');
        if(!response.ok)throw Error('Could not check the processing worker.');
        const c=await response.json();
        status.textContent=c.error||'Local processing capabilities';
        for(const [name,ready] of [['Python',c.python],['Image processing',c.numpy&&c.opencv],['Video processing',c.ffmpeg&&c.ffprobe],['Automatic classifier',c.classifier],['Reconstruction adapter configured',c.reconstructor]]){
            const li=document.createElement('li');li.textContent=name+': '+(ready?'available':'not configured');list.append(li);
        }
    }catch(error){status.textContent=error.message+' Open Processing setup in intake to retry.';}
})();
