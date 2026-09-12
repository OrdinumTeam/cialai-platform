// SPDX-License-Identifier: Apache-2.0
// Fixture local para capturas do telefone. Usa as views reais, um terminal
// fictício e uma fronteira de arquivos inerte, sem PTY ou projeto do usuário.
import { build } from 'esbuild';
import { createServer } from 'node:http';

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ToastProvider} from './src/components/ui.jsx';
import PhoneWorkbench from './src/terminals/ui/PhoneWorkbench.jsx';
import {getState} from './src/terminals/runtime.js';
window.__phoneFixture={getState};
import './src/styles.css'; import './src/desktop/macos.css'; import './src/mobile/mobile.css'; import './src/views/Terminais.css'; import './src/desktop/brand.css';
createRoot(document.getElementById('root')).render(<ToastProvider><div className="ios-shell ios-shell--terminal"><div className="fixture-native"><span>●</span><strong>Mac de demonstração</strong><small>Cialai</small></div><main className="ios-content"><PhoneWorkbench/></main></div></ToastProvider>);
`;

const output = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true,
  write: false,
  outdir: '/tmp/cialai-phone-fixture',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  plugins: [{
    name: 'inert-phone-files',
    setup(api) {
      api.onResolve({ filter: /lib\/native\.js$/ }, ({ importer }) => (
        importer.endsWith('PhoneFiles.jsx') ? { path: 'files', namespace: 'fixture' } : undefined
      ));
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `export const invoke=async(cmd,{path})=>{
          if(cmd==='pty_file_read') return {path,content:'# Cialai\\n\\nEste conteúdo fictício verifica a leitura no celular. Linhas compridas devem quebrar na largura disponível sem criar rolagem horizontal.\\n\\nexport const layout = "mobile";',size:220};
          if(cmd!=='pty_files_list') throw Error('Fixture read only');
          return {path,entries:path ? [{name:'App.jsx',path:path+'/App.jsx',kind:'file',size:220},{name:'mobile.css',path:path+'/mobile.css',kind:'file',size:120}] : [{name:'apps',path:'apps',kind:'dir',size:0},{name:'docs',path:'docs',kind:'dir',size:0},{name:'packages',path:'packages',kind:'dir',size:0},{name:'README.md',path:'README.md',kind:'file',size:220}],truncated:false};
        };`,
        loader: 'js',
      }));
    },
  }],
});

const js = output.outputFiles.find((file) => file.path.endsWith('.js')).contents;
const css = output.outputFiles.find((file) => file.path.endsWith('.css')).contents;
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(js);
    return;
  }
  if (request.url === '/fixture.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(css);
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html data-platform="macos" data-form-factor="phone" data-theme="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>.fixture-native{height:44px;flex:none;display:flex;gap:8px;align-items:center;padding:0 16px;font-size:15px;border-bottom:1px solid #333}.fixture-native span{color:#30d158}.fixture-native small{margin-left:auto;color:#ff7ab2}</style><div id="root"></div><script src="/fixture.js"></script></html>');
});
server.listen(0, '127.0.0.1', () => console.log(`Phone fixture: http://127.0.0.1:${server.address().port}/?terminais=demo`));
