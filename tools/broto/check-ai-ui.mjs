// SPDX-License-Identifier: Apache-2.0
// Isolated real React components with a deterministic native boundary.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createI18n } from '@cialai/i18n';
const mock = `
const listeners = new Set();
let pending = [{id:1,deviceId:'alpha',cmd:'exec',summary:JSON.stringify({command:'echo',args:['hello']})},{id:2,deviceId:'alpha',cmd:'exec',summary:JSON.stringify({command:'echo',args:['next']})}];
let devices = [{id:'alpha',name:'Windows de teste',platform:'windows',status:'connected',level:'confirm'}];
export const isTauri = () => true;
export const listen = async (_,cb) => { listeners.add(cb); return () => listeners.delete(cb); };
const changed = () => listeners.forEach(cb=>cb({event:'broto.requests.changed'}));
window.reorderRequests = () => { pending.reverse(); changed(); };
export const invoke = async (command,args) => {
 window.calls.push({command,args});
 if(command==='broto_requests') return pending;
 if(command==='broto_list') return devices;
 if(command==='broto_pair_pending') return [];
 if(command==='skill_status') return window.sharedSkills ? [{agent:'claude',state:'installed',shared:true},{agent:'codex',state:'installed',shared:true}] : [{agent:'claude',state:'available'},{agent:'codex',state:'installed'}];
 if(command==='skill_change') return [{agent:'claude',state:args.remove?'available':'installed',shared:!!window.sharedSkills},{agent:'codex',state:args.remove?'available':'installed',shared:!!window.sharedSkills}];
 if(command==='broto_decide') { pending = pending.filter(p=>p.id!==args.id); changed(); return {}; }
 if(command==='broto_grant') { pending=[]; devices=devices.map(d=>({...d,approvalUntil:args.end?'':new Date(Date.now()+900000).toISOString()}));changed();return {}; }
 if(command==='broto_rename') {devices=devices.map(d=>({...d,name:args.name})); return {}; }
 return {};
};`;
const bundle = await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import Approvals from './packages/ui/src/desktop/BrotoApprovals.jsx'; import Brotos from './packages/ui/src/desktop/Brotos.jsx'; import './packages/ui/src/desktop/desktop.css'; window.calls=[]; createRoot(document.getElementById('root')).render(<div className="mac-main"><header className="mac-toolbar">Cialai</header><Approvals/><div className="mac-body"><main className="mac-content mac-devices"><Brotos onRevoke={()=>{}}/><div data-testid="ai-card"><Approvals deviceId="alpha"/></div></main></div></div>);`,resolveDir:process.cwd(),loader:'jsx'}, bundle:true,write:false,outdir:'/tmp/broto-ui',format:'iife',loader:{'.woff2':'dataurl','.woff':'dataurl','.png':'dataurl','.jpg':'dataurl','.svg':'dataurl'},plugins:[{name:'native-fixture',setup(api){api.onResolve({filter:/lib\/native\.js$/},()=>({path:'native',namespace:'fixture'}));api.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock}));}}]});
const systemBrowsers = process.platform === 'darwin' ? ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : process.platform === 'linux' ? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'] : [];
const executablePath = process.env.BROTO_UI_BROWSER || (existsSync(chromium.executablePath()) ? undefined : systemBrowsers.find(existsSync));
const browser = await chromium.launch({headless:true,executablePath});
try {
 for (const locale of ['en', 'pt-BR', 'es']) {
 const t = createI18n(locale).t;
 const page = await browser.newPage({locale,viewport:{width:1440,height:1000}});
 page.setDefaultTimeout(10000);
 const errors=[]; page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<html data-shell="desktop" data-theme="dark" data-platform="macos"><body><div id="root"></div></body></html>');
 await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text});
 await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
 const banner=page.locator('.mac-main > .broto-approvals');
 await banner.getByText(t('desktop.brotos.grant'),{exact:true}).first().waitFor();
 assert.equal(await banner.locator('.broto-approval').count(),1,'one visible request per Broto in banner');
 assert.ok(await page.locator('.mac-main > .broto-approvals').evaluate(el=>el.getBoundingClientRect().top>=52),'approval remains below the toolbar');
 const all = page.locator('[data-broto-requests="all"]');
 const card = page.locator('[data-testid="ai-card"]');
 assert.equal(await all.locator('[data-request-id]').count(),2,'Devices retains every pending request');
 await banner.locator('[data-broto-queue-next]').click();
 await card.locator('[data-request-id="2"]').waitFor();
 await page.evaluate(()=>window.reorderRequests());
 await banner.locator('[data-request-id="2"]').waitFor();
 await banner.locator('[data-broto-queue-prev]').click();
 await card.locator('[data-request-id="1"]').waitFor();

 await page.screenshot({path:join(tmpdir(),`broto-ai-ui-${locale}-wide.png`),fullPage:true});
 await banner.getByRole('button',{name:t('desktop.brotos.approve'),exact:true}).first().click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.broto-request-preview')].every(el=>el.textContent==='echo next'));
 await banner.getByRole('button',{name:t('desktop.brotos.grant')}).first().click();
 await page.getByText(t('desktop.brotos.granted',{minutes:15})).first().waitFor();
 await page.getByRole('button',{name:t('desktop.brotos.rename'),exact:true}).click();
 await page.getByRole('textbox',{name:t('desktop.brotos.rename')}).fill('VM de trabalho');
 await page.getByRole('button',{name:t('desktop.action.save'),exact:true}).click();
 await page.getByText('VM de trabalho',{exact:true}).waitFor();
 assert.equal(await page.getByText(t('desktop.brotos.granted',{minutes:16}),{exact:true}).count(),0,'grant countdown never exceeds fifteen minutes');
 await page.getByRole('button',{name:t('desktop.brotos.skillInstall'),exact:true}).click();
 await page.getByRole('button',{name:t('desktop.brotos.skillRemove'),exact:true}).nth(1).waitFor();
 await page.setViewportSize({width:820,height:1050});
 await page.screenshot({path:join(tmpdir(),`broto-ai-ui-${locale}-narrow.png`),fullPage:true});
 const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
 assert.equal(geometry.width,geometry.scroll,'no horizontal document overflow');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,locale,checks:['queue navigation synchronized','stable selection after refresh','Devices pending list','approval deduplication','decision synchronized','temporary grant','rename','skill installation','responsive width'],geometry,screenshots:[join(tmpdir(),`broto-ai-ui-${locale}-wide.png`),join(tmpdir(),`broto-ai-ui-${locale}-narrow.png`)]}));
 await page.close();
 }
 const sharedPage=await browser.newPage({locale:'en'});
 await sharedPage.setContent('<html><body><div id="root"></div></body></html>');
 await sharedPage.evaluate(()=>{window.sharedSkills=true});
 await sharedPage.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
 const sharedButton=sharedPage.getByRole('button',{name:createI18n('en').t('desktop.brotos.skillRemoveShared'),exact:true});
 await sharedButton.waitFor();
 assert.equal(await sharedButton.count(),1,'shared install has one explicit removal');
 await sharedButton.click();
 await sharedPage.waitForFunction(()=>window.calls.some(c=>c.command==='skill_change' && c.args.remove===true && c.args.removeShared===true));
 console.log(JSON.stringify({passed:true,check:'explicit shared skill removal'}));
 await sharedPage.close();
} finally {await browser.close();}
