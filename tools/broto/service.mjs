// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
function valid(value) {if(!value || /[\r\n\0]/.test(value)) throw new Error('Invalid service path'); return value;}
const xml = v=>valid(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const unit = v=>'"'+valid(v).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
export function service(platform,binary) {
  if(platform==='darwin')return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>br.com.ordinum.cialai.broto</string><key>ProgramArguments</key><array><string>${xml(binary)}</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer></dict></plist>\n`;
  if(platform==='linux')return `[Unit]\nDescription=Cialai Broto\nAfter=network-online.target\n[Service]\nExecStart=${unit(binary)} serve\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=default.target\n`;
  throw new Error('Windows requires SCM installation with a dedicated non-administrator account; see README');
}
if(process.argv[1]===fileURLToPath(import.meta.url)) process.stdout.write(service(...process.argv.slice(2)));
