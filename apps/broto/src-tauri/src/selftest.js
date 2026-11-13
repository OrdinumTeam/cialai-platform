// Native WebKit selftest uses real protected service IPC and production controls.
(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async check=>{
    const deadline=Date.now()+25000;
    while(!await check()){
      if(Date.now()>deadline)throw Error('native_ui_state_timeout');
      await delay(100);
    }
  };
  const status=()=>invoke('broto_control',{method:'broto.status',params:{}});
  const stage=(stage,digits=null)=>invoke('broto_selftest_stage',{stage,digits});
  const click=async action=>{
    await wait(()=>document.querySelector(`[data-broto-action="${action}"]`));
    document.querySelector(`[data-broto-action="${action}"]`).click();
  };
  try{
    await wait(()=>document.querySelector('#pairing'));
    const initial=await status();
    if(initial.state!=='disconnected')throw Error('isolated_service_not_disconnected');
    const report={passed:true,nativeWindow:true,connectForm:true,serviceIPC:true,state:initial.state,activityArray:Array.isArray(initial.activity)};
    const pairing=await invoke('broto_selftest_pairing');
    if(pairing){
      const field=document.querySelector('#pairing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,pairing);
      field.dispatchEvent(new Event('input',{bubbles:true}));
      await wait(()=>!document.querySelector('[data-broto-action="connect"]').disabled);
      await click('connect');
      await wait(async()=> (await status()).state==='waiting' && document.querySelector('.broto-digits')?.textContent.trim().length===4);
      await stage('waiting',(await status()).digits);
      await wait(async()=> (await status()).state==='connected');
      await stage('connected');
      await wait(async()=> (await status()).activity.length>0 && document.querySelectorAll('.broto-activity li').length>0);
      await click('pause');
      await wait(async()=> (await status()).state==='paused');
      await stage('paused');
      await click('resume');
      await wait(async()=> (await status()).state==='connected');
      await stage('resumed');
      await click('disconnect');
      await wait(async()=> (await status()).state==='disconnected' && document.querySelector('#pairing'));
      await stage('disconnected');
      Object.assign(report,{paired:true,waitingDigits:true,connected:true,activityVisible:true,paused:true,resumed:true,disconnected:true});
    }
    await invoke('broto_selftest_done',{report});
  }catch(error){await invoke('broto_selftest_done',{report:{passed:false,error:String(error)}});}
})();
