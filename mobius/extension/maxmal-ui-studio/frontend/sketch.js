'use strict';
// Sketch-specific interactions remain local demo state; no business API is invoked.
const STUDIO_DEFAULTS = {
  mode: 'projects', evolutionOnly: false, rightView: 'files', version: '0.3.0',
  skills: [{id:'skill-design',name:'前端设计',description:'布局、字体与交互的一致性'}, {id:'skill-test',name:'浏览器验证',description:'检查页面、交互与视觉反馈'}, {id:'skill-chief',name:'研究主导',description:'拆分目标，协调团队并汇总结果'}],
  memories: [{id:'memory-style',name:'界面偏好',description:'保持简洁的 Codex 风格与留白'}, {id:'memory-project',name:'项目约定',description:'先明确目标，再逐步实现和验证'}],
  draftContext: {skills:[],memories:[]}, cluster:{regions:true,edges:true,teams:true},
  files:{'README.md':'# 我的工作空间\n\n让复杂的事情变得简单。','src/main.js':'// 界面演示\nconst message = "Hello, Mobius";\nconsole.log(message);','src/style.css':'body {\n  background: #fff;\n  color: #303234;\n}'}, document:'项目笔记\n\n在这里记录目标、结论与下一步。'
};
function ensureStudio() {
  content.studio ||= {};
  for (const [key, value] of Object.entries(STUDIO_DEFAULTS)) if (content.studio[key] === undefined) content.studio[key] = structuredClone(value);
  if (!['projects','professional'].includes(content.studio.mode)) content.studio.mode='projects';
  if (!content.studio.sketchSeeded) {
    if (!content.issues.some(r=>r.isSelfEvolve)) content.issues.push({id:'self-evolve-ui',title:'极简工作台迭代',description:'围绕真实使用反馈，逐步优化工作台。',isSelfEvolve:true,backingProject:'mobius-self-evolve',sessions:[{id:'self-evolve-session',title:'导航与工作区优化',messages:[]}]});
    content.studio.sketchSeeded=true;
  }
  content.research.forEach(r=>r.sessions.forEach(session=>{if(session.role==='chief'&&!session.model)session.model=r.model;}));
  content.works.forEach(w=>{if(!w.sessions?.length)w.sessions=[{id:w.id+'-editor',title:'迭代 '+w.title,messages:[]}];});
  return content.studio;
}
ensureStudio();
groups.professional.label='研究系统';
let popover=null, popoverAnchor=null;
function closePopover(restore=false){if(popover){popover.remove();popover=null;}if(restore&&popoverAnchor?.isConnected)popoverAnchor.focus();popoverAnchor=null;}
function showPopover(anchor, build, width=270){
  closePopover();popoverAnchor=anchor;
  popover=node('div','studio-popover');popover.setAttribute('role','dialog');popover.setAttribute('aria-label','操作选项');popover.style.width=Math.min(width,innerWidth-24)+'px';document.body.append(popover);build(popover);
  const r=anchor.getBoundingClientRect(),h=popover.getBoundingClientRect().height,w=popover.getBoundingClientRect().width;
  popover.style.left=Math.max(12,Math.min(r.left,innerWidth-w-12))+'px';popover.style.top=Math.max(12,r.bottom+h+10<innerHeight?r.bottom+6:r.top-h-6)+'px';
  popover.querySelector('input,button')?.focus({preventScroll:true});
}
function menuItem(root,label,fn,options={}){const b=button(label,()=>{closePopover();fn();},options.selected?'active':'',options.icon);b.disabled=!!options.disabled;root.append(b);return b;}
function caption(root,text){root.append(node('div','popover-caption',text));}
function divider(root){root.append(node('div','popover-divider'));}
document.addEventListener('pointerdown',e=>{if(popover&&!popover.contains(e.target)&&!popoverAnchor?.contains(e.target))closePopover();},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&popover){e.preventDefault();closePopover(true);}},true);
window.addEventListener('resize',()=>{closePopover();placePet();});
function currentSession(){const r=getRecord();return r?.sessions?.find(s=>s.id===route.session);}
function selectedContext(){const s=currentSession();if(s){s.context||=structuredClone(ensureStudio().draftContext);return s.context;}return ensureStudio().draftContext;}
function resourcesSummary(selection=selectedContext()){const st=ensureStudio();return ['skills','memories'].flatMap(type=>(selection[type]||[]).map(id=>st[type].find(x=>x.id===id)?.name).filter(Boolean));}
function switchMode(mode){content.studio.mode=mode;content.studio.evolutionOnly=false;recentLimit=RECENT_PAGE_SIZE;recentFilter='all';expanded.clear();persist();go({group:mode,kind:'welcome'});}
actions['mode-menu']=()=>showPopover($('.brand'),root=>{caption(root,'工作空间');for(const [key,label] of [['projects','普通项目'],['professional','研究系统']])menuItem(root,label,()=>switchMode(key),{selected:content.studio.mode===key,icon:key==='projects'?'folder':'branch'});});
$('.brand').dataset.action='mode-menu';$('.brand').setAttribute('aria-label','切换普通项目或研究系统');
const modeCaption=node('span','brand-mode');$('.brand').append(modeCaption);
$('nav').replaceChildren();
const sketchNew=button('新对话',()=>beginNewSession(),'', 'edit');sketchNew.dataset.nav='new';$('nav').append(sketchNew);
const extensionNav=button('拓展系统',()=>openExtensionPicker(),'', 'grid');extensionNav.dataset.nav='extensions';$('nav').append(extensionNav);
const deviceNav=button('设备与连接',()=>deviceSettings(),'', 'globe');deviceNav.dataset.nav='devices';$('nav').append(deviceNav);
for(const [b,key,text]of[[sketchNew,'sketch-new','新对话'],[extensionNav,'sketch-extensions','拓展系统'],[deviceNav,'sketch-devices','设备与连接']]){const action=b.onclick;initialCopies[key]=text;const label=b.querySelector('span');label.dataset.copy=key;label.textContent=state.copies[key]??text;b.onclick=event=>{if(!editing)action(event);};}
const clusterEntry=node('div','cluster-entry');const projectLabel=node('span','','项目');const clusterButton=button('',()=>go({group:content.studio.mode,kind:'cluster'}),'','branch');clusterButton.setAttribute('aria-label','Cluster-Overview');clusterButton.title='Cluster-Overview';clusterEntry.append(projectLabel,clusterButton);sidebarBody.before(clusterEntry);
const footer=$('.sidebar footer');footer.replaceChildren();
const settingsButton=button('设置',()=>openSettings(),'','help');settingsButton.setAttribute('aria-label','设置');
const evolveButton=button('自迭代',()=>{const st=ensureStudio();st.evolutionOnly=!st.evolutionOnly;st.mode='projects';recentLimit=10;expanded.clear();persist();go({group:'projects',kind:'welcome'});},'','review');evolveButton.setAttribute('aria-label','自迭代');footer.append(settingsButton,evolveButton);
const baseRecentRecords=recentRecords;
recentRecords=()=>baseRecentRecords().filter(x=>x.group===ensureStudio().mode&&(!content.studio.evolutionOnly||x.record.isSelfEvolve)).sort((a,b)=>Number(!!b.record.pinned)-Number(!!a.record.pinned)||(b.record.lastOpenedAt||0)-(a.record.lastOpenedAt||0));
const baseGoSketch=go;
go=(next,replace=false)=>{
  ensureStudio();closePopover();
  if(['projects','professional'].includes(next.group)&&next.kind!=='cluster'){
    content.studio.mode=next.group;
    const record=(next.group==='projects'?content.issues:content.research).find(r=>r.id===next.id);
    if(record&&!record.isSelfEvolve)content.studio.evolutionOnly=false;
    if(next.kind==='session'){const s=record?.sessions.find(x=>x.id===next.session);if(s&&!s.context)s.context=structuredClone(content.studio.draftContext);}
  }
  if(next.group==='works'&&next.id){const w=content.works.find(x=>x.id===next.id);if(w){next={group:'works',kind:'session',id:w.id,session:w.sessions[0].id};content.studio.rightView='app';ensureRightOpen();}}
  persist();baseGoSketch(next,replace);
};
function beginNewSession(){
  if(content.studio.mode==='professional'){createProfessional();return;}
  const eligible=content.issues.filter(r=>!content.studio.evolutionOnly||r.isSelfEvolve);
  if(!eligible.length){createProject();return;}
  modal('新对话',root=>{const label=node('p','subtle','选择项目后，在输入区选择本次需要的 Skill 和 Memory。');root.append(label);const input=node('input');input.placeholder='搜索项目';input.setAttribute('aria-label','搜索项目');input.style.width='100%';const list=node('div','space-search-results');root.append(input,list);let limit=30;const update=()=>{list.replaceChildren();const matches=eligible.filter(r=>r.title.toLowerCase().includes(input.value.toLowerCase()));matches.slice(0,limit).forEach(r=>choice(list,r.title,()=>{const s={id:uid('session'),title:'新对话',messages:[],context:structuredClone(content.studio.draftContext)};r.sessions.push(s);persist();$('#dialog').close();go({group:'projects',kind:'session',id:r.id,session:s.id});}));if(matches.length>limit)choice(list,'显示更多',()=>{limit+=30;update();});if(!matches.length)note(list,'没有匹配的项目');};input.oninput=()=>{limit=30;update();};update();choice(root,'＋ 新建项目',()=>createProject());});
}
actions.new=beginNewSession;
function openExtensionPicker(){modal('拓展系统',root=>{note(root,'选择作品，左侧对话负责迭代，右侧打开应用预览。');content.works.forEach(w=>choice(root,w.title,()=>{$('#dialog').close();go({group:'works',kind:'session',id:w.id,session:w.sessions[0].id});}));choice(root,'＋ 创造新作品',()=>createWork());});}
function deviceSettings(){modal('设备与连接',root=>{note(root,'统一管理工作目录、算力与连接。下列为前端演示设备。');const list=node('div','device-modal-list');content.worlds.forEach(w=>detailRow(list,w.title,w.kind+' · '+w.address,()=>{$('#dialog').close();go({group:'world',kind:'detail',id:w.id});},'globe',pill(w.status==='connected'?'已连接 · 演示':'未连接')));root.append(list);const row=node('div','actions');row.append(button('连接本机',()=>connectWorld('本地设备')),button('添加 SSH',()=>connectWorld('SSH')),button('反向连接',()=>connectWorld('反向连接')));root.append(row);});}
$('.composer').classList.add('sketch-composer');
const skillButton=button('Skill',()=>resourcePicker('skills',skillButton),'context-chip');skillButton.setAttribute('aria-label','选择 Skill');
const memoryButton=button('Memory',()=>resourcePicker('memories',memoryButton),'context-chip');memoryButton.setAttribute('aria-label','选择 Memory');
$('.composer-bottom .approval').after(skillButton,memoryButton);
function resourcePicker(type,anchor){showPopover(anchor,root=>{caption(root,(currentSession()?.messages.length?'追加或强调':'本次会话')+' · '+(type==='skills'?'Skill':'Memory'));const search=node('input','resource-search');search.placeholder='搜索'+(type==='skills'?' Skill':' Memory');search.setAttribute('aria-label','筛选上下文');const options=node('div','resource-options');root.append(search,options);const update=()=>{options.replaceChildren();const selected=selectedContext();ensureStudio()[type].filter(r=>(r.name+' '+r.description).toLowerCase().includes(search.value.toLowerCase())).forEach(r=>{const label=node('label');const check=node('input');check.type='checkbox';check.checked=(selected[type]||[]).includes(r.id);check.setAttribute('aria-label',r.name);const body=node('div');body.append(node('div','',r.name),node('div','resource-caption',r.description));label.append(check,body);options.append(label);check.onchange=()=>{selected[type]||=[];selected[type]=check.checked?[...new Set([...selected[type],r.id])]:selected[type].filter(x=>x!==r.id);const s=currentSession();if(s?.messages.length){s.contextEvents||=[];s.contextEvents.push({at:Date.now(),type,name:r.name,action:check.checked?'追加强调':'移除后续注入'});}persist();refreshContextButtons();};});if(!options.children.length)options.append(node('p','preview-notice','没有匹配的内容'));};search.oninput=update;update();divider(root);if(currentSession()?.messages.length)menuItem(root,'再次强调所选内容',()=>{const session=currentSession();session.contextEvents||=[];session.contextEvents.push({at:Date.now(),type,action:'再次强调',names:resourcesSummary()});persist();toast('所选上下文已标为下一轮重点');});menuItem(root,'管理 Skill 和 Memory',()=>resourceManager(type));},320);}
function refreshContextButtons(){const c=selectedContext();for(const [type,b,label]of[['skills',skillButton,'Skill'],['memories',memoryButton,'Memory']]){const count=(c[type]||[]).filter(id=>content.studio[type].some(r=>r.id===id)).length;b.firstElementChild.textContent=label+(count?' '+count:'');b.classList.toggle('has-selection',!!count);}}
function resourceManager(type='skills'){modal('Skill 和 Memory 管理',root=>{const tabbar=node('div','actions');tabbar.append(button('Skill',()=>resourceManager('skills'),type==='skills'?'quiet-button primary':'quiet-button'),button('Memory',()=>resourceManager('memories'),type==='memories'?'quiet-button primary':'quiet-button'));root.append(tabbar);const list=node('div','space-search-results');content.studio[type].forEach(r=>{const row=node('div','resource-manager-row');const text=node('div');text.append(node('strong','',r.name),node('p','',r.description));row.append(text,button('编辑',()=>editResource(type,r),''),button('删除',()=>{content.studio[type]=content.studio[type].filter(x=>x.id!==r.id);persist();resourceManager(type);refreshContextButtons();},''));list.append(row);});root.append(list);choice(root,'＋ 新建'+(type==='skills'?' Skill':' Memory'),()=>editResource(type));note(root,'维护的是演示资源；每段会话独立选择需要注入的内容。');});}
function editResource(type,r){form(r?'编辑资源':'新建资源',[{key:'name',label:'名称',value:r?.name},{key:'description',label:'内容',type:'textarea',value:r?.description}],v=>{if(r)Object.assign(r,v);else content.studio[type].push({id:uid(type),...v});persist();refreshContextButtons();},'保存');}
const designSettings=actions.settings;
function openSettings(){showPopover(settingsButton,root=>{caption(root,'设置');menuItem(root,'用户中心',()=>form('用户中心',[{key:'name',label:'显示名称',value:content.studio.displayName||'我'}],v=>{content.studio.displayName=v.name;persist();},'保存'));menuItem(root,'管理中心',()=>modal('管理中心',r=>{for(const [label,items]of[['普通项目',content.issues],['研究系统',content.research],['拓展作品',content.works],['连接设备',content.worlds]])note(r,label+'：'+items.length);note(r,'这里只展示本地演示资源概览。');}));menuItem(root,'通用与外观',()=>designSettings());menuItem(root,'连接客户端',deviceSettings);divider(root);menuItem(root,'Skill 和 Memory 管理',()=>resourceManager());menuItem(root,'版本跟踪与自进化',evolutionSettings);});}
actions.settings=openSettings;actions.profile=openSettings;
function evolutionSettings(){modal('版本跟踪与自进化',root=>{note(root,'当前演示版本：'+content.studio.version+'。切换只改变预览状态，不重启或回退真实服务。');for(const version of ['0.3.0','0.2.0','0.1.0']){const b=choice(root,version+(content.studio.version===version?' · 当前':''),()=>{content.studio.version=version;persist();evolutionSettings();});if(version===content.studio.version)b.classList.add('version-selected');}const card=node('div','self-plugin-card');card.append(node('h3','','自进化助手'),node('p','','扫描工作台体验，生成可讨论的改进建议。'),button('预览扫描建议',()=>{const r=content.issues.find(x=>x.isSelfEvolve);if(!r)return;const s={id:uid('evolution'),title:'体验改进建议',messages:[{role:'assistant',at:Date.now(),text:'演示扫描建议：\n1. 检查窄屏下的输入区按钮是否易于操作。\n2. 在拓展迭代时保持对话和应用预览同步。\n\n这些是预设建议，未扫描真实服务。'}]};r.sessions.push(s);content.studio.evolutionOnly=true;persist();$('#dialog').close();go({group:'projects',kind:'session',id:r.id,session:s.id});}));root.append(card);});}
const baseRenderTop=renderTop;
renderTop=()=>{baseRenderTop();const quick=button('···',()=>quickActions(quick),'quick-menu');quick.innerHTML='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h.01 M12 12h.01 M20 12h.01" stroke-width="3"/></svg>';quick.setAttribute('aria-label','会话快捷操作');topbar.prepend(quick);};
function quickActions(anchor){const r=getRecord(),s=currentSession();showPopover(anchor,root=>{caption(root,s?.title||r?.title||'快速操作');menuItem(root,(s||r)?.pinned?'取消置顶':'置顶',()=>{const target=s||r;target.pinned=!target.pinned;if(s)r.pinned=s.pinned;persist();render();},{disabled:!r});menuItem(root,'重命名',()=>form('重命名',[{key:'title',label:'名称',value:(s||r).title}],v=>{(s||r).title=v.title;persist();render();},'保存'),{disabled:!r});menuItem(root,'修改模型并继续',()=>modelPicker($('.model'),true),{disabled:!s});menuItem(root,'提炼项目知识',()=>extractKnowledge(r,s),{disabled:!r});menuItem(root,'耗时与用量',()=>modal('耗时与用量',body=>{const chars=(s?.messages||[]).reduce((n,m)=>n+m.text.length,0);note(body,'消息数：'+(s?.messages.length||0));note(body,'文本长度：'+chars+' 字符');note(body,'Token 本地粗估：'+Math.ceil(chars/4)+'（不代表真实计费）');note(body,'未连接模型，暂无真实执行耗时。');}),{disabled:!s});divider(root);menuItem(root,s?.paused?'恢复会话':'挂起会话',()=>{s.paused=!s.paused;persist();render();},{disabled:!s});menuItem(root,'删除会话',()=>{r.sessions=r.sessions.filter(x=>x.id!==s.id);persist();go({group:route.group,kind:'detail',id:r.id});},{disabled:!s||s.role==='chief'});});}
function extractKnowledge(r,s){const text=r.knowledge||(s?.messages.filter(m=>m.role==='user').map(m=>m.text).slice(-4).join('\n\n'))||r.description||'';form('提炼项目知识',[{key:'knowledge',label:'核对并保存到项目知识',type:'textarea',value:text}],v=>{r.knowledge=v.knowledge;persist();toast('已保存演示项目知识');},'保存知识');}
function modelPicker(anchor,continuing=false){showPopover(anchor,root=>{caption(root,'Harness');for(const harness of ['Codex','Claude Code'])menuItem(root,harness,()=>{const s=currentSession();if(s)s.harness=harness;else content.studio.harness=harness;persist();toast('已更新演示 Harness');},{selected:(currentSession()?.harness||content.studio.harness||'Codex')===harness});divider(root);caption(root,continuing?'选择模型并继续':'模型');for(const model of ['GPT-6 高','5.6 Sol 高','5.6 Sol 中'])menuItem(root,model,()=>{state.model=model;save();const s=currentSession();if(s){s.model=model;if(continuing){s.paused=false;s.messages.push({role:'assistant',at:Date.now(),text:'已切换为 '+model+'。可以从当前上下文继续输入。（界面演示）'});}}persist();render();},{selected:(currentSession()?.model||state.model)===model});});}
actions.model=()=>modelPicker($('.model'));
actions.attach=()=>attachmentMenu();
function attachmentMenu(){showPopover($('.composer-bottom [data-action=attach]'),root=>{menuItem(root,'添加附件',()=>$('#file').click(),{icon:'plus'});menuItem(root,'压缩上下文',()=>{const s=currentSession();if(!s){toast('先开始一段对话');return;}s.compaction='已整理 '+s.messages.length+' 条演示消息；原始消息仍保留。';persist();render();},{icon:'review'});menuItem(root,'分享会话链接',async()=>{try{await navigator.clipboard.writeText(location.href);toast('链接已复制；演示内容保存在当前浏览器');}catch{toast('浏览器未允许复制，请复制地址栏链接');}},{icon:'branch'});},200);}
const baseSendSketch=sendMessage;
sendMessage=text=>{if(currentSession()?.paused){toast('会话已挂起，请先恢复');return;}const selected=resourcesSummary();baseSendSketch(text);const s=currentSession();if(s&&s.messages.length>=2){const user=s.messages[s.messages.length-2],answer=s.messages[s.messages.length-1];user.at=Date.now();user.contextNames=selected;answer.at=Date.now();persist();renderSession();refreshContextButtons();}};
const baseSessionSketch=renderSession;
renderSession=()=>{baseSessionSketch();const s=currentSession();if(!s)return;const container=$('#conversation');if(s.compaction)container.prepend(node('div','session-state',s.compaction));if(s.paused)container.prepend(node('div','session-state','会话已挂起'));container.querySelectorAll('.message').forEach((el,i)=>{const m=s.messages[i];if(!m)return;if(m.contextNames?.length){const tags=node('div','message-context');m.contextNames.forEach(name=>tags.append(node('span','',name)));el.append(tags);}const tools=node('div','message-tools');tools.append(node('span','',m.at?new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'演示消息'));tools.append(button('复制',async()=>{try{await navigator.clipboard.writeText(m.text);toast('已复制');}catch{toast('浏览器未允许复制');}},''));if(m.role==='assistant')tools.append(button('显示细节',()=>modal('消息细节',root=>{note(root,'类型：前端演示回复');note(root,'模型：'+(s.model||state.model));note(root,'上下文：'+(resourcesSummary(s.context||content.studio.draftContext).join('、')||'未选择额外资源'));note(root,'本会话上下文调整：'+(s.contextEvents?.length||0)+' 次');}),''));el.append(tools);});container.scrollTop=container.scrollHeight;};
const rightPanel=$('.rightbar');rightPanel.classList.add('sketch-right');
const rightWorkspace=node('section','right-workspace');rightWorkspace.setAttribute('aria-label','右侧工作区');rightPanel.append(rightWorkspace);
const pet=button('',()=>petMenu(),'pet-button');pet.setAttribute('aria-label','小莫');pet.title='小莫';pet.innerHTML=$('.mascot').outerHTML;rightPanel.append(pet);
function rightVisible(){if(innerWidth<=960)return $('#app').classList.contains('mobile-right');return !$('#app').classList.contains('no-right');}
function ensureRightOpen(){if(innerWidth<=960)$('#app').classList.add('mobile-right');else $('#app').classList.remove('no-right');}
function placePet(){(rightVisible()?rightPanel:main).append(pet);}
const baseRightToggle=actions.right,baseFocusToggle=actions.focus;
actions.right=()=>{baseRightToggle();placePet();};actions.focus=()=>{baseFocusToggle();placePet();};
function petMenu(){showPopover(pet,root=>{caption(root,'小莫');menuItem(root,'我现在可以做什么？',()=>modal('小莫',r=>{note(r,route.group==='works'?'在中间讨论作品的修改，在右侧立即体验应用。':content.studio.mode==='professional'?'先把目标交给 Chief，再查看团队和进展。':'选择项目并开始对话；Skill 和 Memory 在输入区随时可选。');}));menuItem(root,'看看整个工作空间',()=>go({group:content.studio.mode,kind:'cluster'}));menuItem(root,'调整界面',()=>designSettings());},230);}
function appPreviewURL(w){return new URL('./app-preview.html?work='+encodeURIComponent(w.id),location.href).href;}
function makeFrame(url,title){const frame=node('iframe','app-frame');frame.title=title;const parsed=new URL(url,location.href);if(!['http:','https:'].includes(parsed.protocol))throw Error('只支持 HTTP 或 HTTPS 地址');frame.setAttribute('sandbox',parsed.origin===location.origin?'allow-scripts allow-same-origin allow-forms':'allow-scripts');frame.referrerPolicy='no-referrer';frame.src=parsed.href;return frame;}
function renderRightWorkspace(){
  rightWorkspace.replaceChildren();const st=ensureStudio();const bar=node('div','right-view-bar');const select=node('select');select.setAttribute('aria-label','右侧视图');for(const [value,label]of [['files','文件'],['vscode','VS Code'],['app','应用预览'],['browser','浏览器'],['document','文档']]){const opt=node('option','',label);opt.value=value;select.append(opt);}select.value=st.rightView;select.onchange=()=>{st.rightView=select.value;persist();renderRightWorkspace();};bar.append(select,node('span','right-caption',route.group==='works'?(getRecord()?.title||'作品'):'工作空间'));const body=node('div','right-view-body');rightWorkspace.append(bar,body);
  if(st.rightView==='app'){
    const work=route.group==='works'?getRecord():content.works[0];
    if(!work){body.append(node('p','right-browser-empty','还没有作品，从「拓展系统」创建一个。'));return;}
    const address=node('div','right-address');const input=node('input');input.value=appPreviewURL(work);input.readOnly=true;input.setAttribute('aria-label','应用 URL');address.append(input,button('↻',()=>renderRightWorkspace(),''));body.append(address,makeFrame(input.value,work.title+'应用预览'));return;
  }
  if(st.rightView==='browser'){
    const address=node('form','right-address');const input=node('input');input.placeholder='https://…';input.value=st.browserURL||'';input.setAttribute('aria-label','浏览器地址');address.append(input,button('打开',()=>address.requestSubmit(),''));body.append(address);const area=node('div','right-view-body');body.append(area);
    const show=url=>{area.replaceChildren();try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw Error();area.append(makeFrame(parsed.href,'浏览器预览'));st.browserURL=parsed.href;persist();}catch{area.append(node('p','right-browser-empty','请输入完整的 HTTP 或 HTTPS 地址。'));}};
    address.onsubmit=e=>{e.preventDefault();show(input.value.trim());};
    if(st.browserURL)show(st.browserURL);else{area.append(node('p','right-browser-empty','打开页面，和对话并排查看。部分网站可能限制嵌入。'));if(content.works[0])area.append(button('打开示例作品',()=>{input.value=appPreviewURL(content.works[0]);show(input.value);},'quiet-button'));}return;
  }
  if(st.rightView==='document'){
    const mode=node('select');mode.setAttribute('aria-label','文档类型');['Markdown','Word','PPT','Excel','PDF'].forEach(type=>{const opt=node('option','',type);opt.value=type;mode.append(opt);});mode.style.cssText='border:0;color:#999;background:transparent;font-size:11px;margin-bottom:12px';body.append(mode);const doc=node('div','right-document');doc.contentEditable='true';doc.setAttribute('role','textbox');doc.setAttribute('aria-label','文档内容');doc.textContent=st.document;doc.oninput=()=>{st.document=doc.textContent;persist();};body.append(doc,node('p','right-status','通用编辑排版演示，不解析真实 Office 或 PDF 文件。'));return;
  }
  const tree=node('div','right-files');tree.append(node('div','folder','工作目录'));for(const file of Object.keys(st.files))tree.append(button(file,()=>{st.openFile=file;persist();renderRightWorkspace();},'',file.endsWith('.md')?'folder':'terminal'));body.append(tree);
  const file=st.openFile||'README.md';const header=node('div','editor-head');header.append(node('span','',file),button('保存',()=>{st.files[file]=editor.value;persist();toast('已保存本地演示文件');},''));const editor=node('textarea','right-code');editor.setAttribute('aria-label',st.rightView==='vscode'?'VS Code 演示编辑器':'文件编辑器');editor.spellcheck=false;editor.value=st.files[file]||'';body.append(header,editor,node('div','right-status',st.rightView==='vscode'?'VS Code 风格编辑布局 · 前端演示':'原生文件编辑器 · 内容保存在当前浏览器'));
}
actions.browser=()=>{content.studio.rightView='browser';ensureRightOpen();persist();renderRightWorkspace();placePet();};
actions.terminal=()=>deviceSettings();
function svgNode(tag,attrs={},text){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function renderCluster(){
  workspace.replaceChildren();workspace.hidden=false;$('.welcome').hidden=true;$('#conversation').hidden=true;$('.composer-wrap').hidden=true;main.classList.add('no-composer');renderTop();
  heading('Cluster-Overview','整个工作空间','项目、团队与设备，在同一个视图中。');
  const controls=node('div','cluster-controls');for(const[key,label]of[['regions','显示区域'],['edges','显示连接边'],['teams','显示多智能体系统']]){const el=node('label');const check=node('input');check.type='checkbox';check.checked=content.studio.cluster[key];check.onchange=()=>{content.studio.cluster[key]=check.checked;persist();renderCluster();};el.append(check,node('span','',label));controls.append(el);}workspace.append(controls);
  const map=svgNode('svg',{viewBox:'0 0 760 470',class:'cluster-map',role:'img','aria-label':'项目、研究团队与设备连接图'});
  if(content.studio.cluster.regions){for(const [x,w,label]of[[16,210,'设备'],[246,240,'普通项目'],[506,238,'研究系统']]){map.append(svgNode('rect',{x,y:18,width:w,height:434,rx:14,class:'region'}),svgNode('text',{x:x+16,y:45,class:'region-label'},label));}}
  const nodes=[];content.worlds.slice(0,3).forEach((r,i)=>nodes.push({x:34,y:85+i*115,w:176,title:r.title,subtitle:r.kind,group:'world',kind:'detail',id:r.id,layer:'device'}));content.issues.slice(0,3).forEach((r,i)=>nodes.push({x:264,y:85+i*115,w:204,title:r.title,subtitle:r.sessions.length+' 段对话',group:'projects',kind:'detail',id:r.id,layer:'issue'}));
  if(content.studio.cluster.teams)content.research.slice(0,2).forEach((r,i)=>{nodes.push({x:524,y:85+i*180,w:202,title:r.title,subtitle:r.sessions.length+' 位智能体',group:'professional',kind:'detail',id:r.id,layer:'research'});nodes.push({x:545,y:160+i*180,w:160,title:r.chief,subtitle:'Chief',group:'professional',kind:'session',id:r.id,session:r.sessions[0].id,layer:'chief'});});
  if(content.studio.cluster.edges){nodes.filter(n=>n.layer==='issue').forEach(n=>map.append(svgNode('path',{d:`M210 117 C236 117 240 ${n.y+32} ${n.x} ${n.y+32}`,class:'cluster-edge'})));nodes.filter(n=>n.layer==='research').forEach(n=>map.append(svgNode('path',{d:`M468 117 C496 117 490 ${n.y+32} ${n.x} ${n.y+32}`,class:'cluster-edge'})));nodes.filter(n=>n.layer==='chief').forEach(n=>map.append(svgNode('path',{d:`M625 ${n.y-11} V${n.y}`,class:'cluster-edge'})));}
  nodes.forEach(n=>{const g=svgNode('g',{class:'cluster-node',tabindex:0,role:'button','aria-label':n.title});g.append(svgNode('rect',{x:n.x,y:n.y,width:n.w,height:64,rx:10}),svgNode('text',{x:n.x+13,y:n.y+26,class:'node-label'},n.title.length>11?n.title.slice(0,11)+'…':n.title),svgNode('text',{x:n.x+13,y:n.y+45,class:'node-caption'},n.subtitle));const open=()=>go({group:n.group,kind:n.kind,id:n.id,...(n.session?{session:n.session}:{})});g.addEventListener('click',open);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});map.append(g);});workspace.append(map,node('p','cluster-legend','全局演示视图，不受左侧模式和自迭代筛选影响。图中展示部分节点，点击可进入对应空间。'));
}
const baseSidebarSketch=renderSidebar;
renderSidebar=()=>{
  baseSidebarSketch();
  sidebarBody.querySelectorAll('.recent-row').forEach(row=>{
    const id=row.querySelector('.recent-title').dataset.sidebarKey;
    const entry=recentRecords().find(x=>x.record.id===id);
    row.oncontextmenu=event=>{event.preventDefault();if(entry)recordMenu(row,entry.record,entry.group);};
  });
};
function recordMenu(anchor,record,group){
  showPopover(anchor,root=>{
    caption(root,record.title);
    menuItem(root,record.pinned?'取消置顶':'置顶',()=>{record.pinned=!record.pinned;persist();renderSidebar();});
    menuItem(root,'重命名',()=>form('重命名项目',[{key:'title',label:'名称',value:record.title}],v=>{record.title=v.title;persist();render();},'保存'));
    menuItem(root,'删除项目',()=>modal('删除演示项目',body=>{note(body,'将删除「'+record.title+'」及其本地演示对话。');choice(body,'取消',()=>$('#dialog').close());choice(body,'删除',()=>{const key=group==='projects'?'issues':'research';content[key]=content[key].filter(r=>r.id!==record.id);persist();$('#dialog').close();go({group,kind:'welcome'});});}));
  },220);
}
const baseRenderSketch=render;
render=()=>{
  ensureStudio();
  if(route.kind==='cluster'){renderSidebar();renderCluster();}
  else baseRenderSketch();
  modeCaption.textContent=content.studio.mode==='professional'?'研究':'';
  projectLabel.textContent=content.studio.evolutionOnly?'自迭代项目':'项目';
  evolveButton.classList.toggle('evolution-on',content.studio.evolutionOnly);evolveButton.setAttribute('aria-pressed',String(content.studio.evolutionOnly));
  extensionNav.classList.toggle('selected',route.group==='works');deviceNav.classList.toggle('selected',route.group==='world');
  $('.project-picker').hidden=route.kind==='session'||route.kind==='cluster';
  refreshContextButtons();$('#model-label').textContent=currentSession()?.model||state.model;
  $('.send').setAttribute('aria-label',currentSession()?.paused?'会话已挂起':'发送消息');
  if(route.kind==='welcome'&&content.studio.evolutionOnly){const h=$('.welcome h1');h.dataset.copy='evolution-heading';initialCopies['evolution-heading']='让工作台不断进化';h.textContent=state.copies['evolution-heading']??initialCopies['evolution-heading'];description.dataset.copy='evolution-description';initialCopies['evolution-description']='从一次真实反馈，开始下一次改进。';description.textContent=state.copies['evolution-description']??initialCopies['evolution-description'];$('#cards').replaceChildren();[['继续优化界面',()=>openSelfIssue()],['版本跟踪与切换',evolutionSettings],['预览自进化建议',evolutionSettings],['查看整体进展',()=>go({group:'projects',kind:'cluster'})]].forEach(([label,fn],i)=>{const b=button(label,fn,'suggestion',['edit','clock','review','branch'][i]);$('#cards').append(b);});welcomeList.replaceChildren();content.issues.filter(r=>r.isSelfEvolve).slice(0,2).forEach(r=>welcomeList.append(button(r.title,()=>go({group:'projects',kind:'detail',id:r.id}),'compact-item','folder')));}
  if(getRecord()?.isSelfEvolve&&route.kind==='detail'){const strip=node('div','evolution-strip');strip.append(node('span','','自迭代空间'),button('版本与自进化',evolutionSettings,''));workspace.prepend(strip);}
  renderRightWorkspace();placePet();
};
function openSelfIssue(){const r=content.issues.find(x=>x.isSelfEvolve);if(r)go({group:'projects',kind:'detail',id:r.id});}
// Keep the existing keyboard shortcut for visual settings, away from host shortcuts.
settings=designSettings;
window.addEventListener('storage',e=>{if(e.key===DEMO_KEY){try{const latest=JSON.parse(e.newValue);if(latest&&Array.isArray(latest.works)){content.works=latest.works;}}catch{}}});
if(['projects','professional'].includes(route.group)&&route.kind==='welcome')route.group=content.studio.mode;
render();persist();
