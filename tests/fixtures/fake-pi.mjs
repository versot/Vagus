import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
// Deliberately implements only the adapter's RPC boundary; never calls a model.
const args = process.argv.slice(2), resume = args.indexOf('--session');
const sessionFile = resume >= 0 ? args[resume + 1] : join(process.env.VAGUS_TEST_DIRECTORY, `pi-${process.pid}.jsonl`);
appendFileSync(process.env.VAGUS_TEST_LOG, JSON.stringify({pid:process.pid, resumed:resume >= 0, probe:args.includes('--no-session'), secretInherited:Boolean(process.env.VAGUS_HOST_TOKEN), sessionFile})+'\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const lines = createInterface({input:process.stdin});
lines.on('close', () => process.exit(0));
lines.on('line', line => {
  const request = JSON.parse(line); let data = {};
  if (request.type === 'get_state') data = {sessionFile, model:{provider:'audit',id:'model',reasoning:false}, isStreaming:false};
  if (request.type === 'get_available_models') data = {models:[{provider:'audit',id:'model',name:'Isolated fixture',reasoning:false}]};
  if (request.type === 'get_commands') data = {commands:[]};
  if (request.type === 'prompt') data = {disposition:'submitted'};
  send({type:'response',id:request.id,command:request.type,success:true,data});
  if (request.type !== 'prompt') return;
  setTimeout(() => {
    send({type:'agent_start'});
    if (request.message === 'crash fixture') {
      send({type:'tool_execution_start',toolCallId:'interrupted-tool',toolName:'fixture',args:{}});
      send({type:'extension_ui_request',id:'interrupted-dialog',method:'confirm',title:'Fixture question'});
      setTimeout(() => process.exit(17), 40); return;
    }
    send({type:'message_start',message:{role:'assistant'}});
    send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Recovered response'}});
    send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Recovered response'}]}});
    send({type:'agent_settled'});
  }, 15);
});
