'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('path'),{pathToFileURL}=require('url');
const {isAppURL,requireTrustedSender,installWindowSecurity}=require('../src/electron-security');
const entry=path.join(__dirname,'../renderer/index.html'),url=pathToFileURL(entry).href;
test('IPC permits only this live window main frame on the exact application entry',()=>{
 const frame={url},contents={mainFrame:frame},win={webContents:contents,isDestroyed:()=>false},valid={sender:contents,senderFrame:frame};assert.doesNotThrow(()=>requireTrustedSender(valid,win,entry));
 for(const event of [null,{}, {...valid,sender:{}},{...valid,senderFrame:{url}}, {...valid,senderFrame:{url:'https://fixture.test'}}])assert.throws(()=>requireTrustedSender(event,win,entry),/non autorizzato/);
 frame.url='https://fixture.test';assert.throws(()=>requireTrustedSender(valid,win,entry),/non autorizzato/);frame.url=url;assert.throws(()=>requireTrustedSender(valid,{...win,isDestroyed:()=>true},entry));
});
test('navigation, webview, external schemes, credentials and permissions are denied without desktop actions',()=>{
 const handlers={},opened=[],session={setPermissionRequestHandler:fn=>session.request=fn,setPermissionCheckHandler:fn=>session.check=fn},contents={session,on:(ch,fn)=>handlers[ch]=fn,setWindowOpenHandler:fn=>contents.open=fn};
 installWindowSecurity({webContents:contents},entry,raw=>{opened.push(raw);});
 for(const ch of ['will-navigate','will-frame-navigate','will-redirect']){let denied=0;handlers[ch]({preventDefault:()=>denied++},'https://fixture.test');assert.equal(denied,1);handlers[ch]({preventDefault:()=>denied++},url);assert.equal(denied,1);}
 let denied=0;handlers['will-attach-webview']({preventDefault:()=>denied++});assert.equal(denied,1);
 for(const raw of ['file:///private','javascript:alert(1)','data:text/html,test','https://user:password@fixture.test','not-a-url'])assert.equal(contents.open({url:raw}).action,'deny');assert.deepEqual(opened,[]);
 contents.open({url:'https://fixture.test/guide'});assert.deepEqual(opened,['https://fixture.test/guide']);let permission;session.request({},'media',value=>permission=value);assert.equal(permission,false);assert.equal(session.check({},'media'),false);assert.equal(isAppURL(url+'#section',entry),true);
});
