const fs=require('node:fs');
const net=require('node:net');
const dgram=require('node:dgram');
const root=process.cwd();
const result={runId:process.argv[2],started:new Date().toISOString(),tcpConnections:0,udpMarkers:0,selfCheckTcp:0,selfCheckUdp:0};
const tcp=net.createServer(s=>{result.tcpConnections++;s.end();});
const udp=dgram.createSocket('udp4');
udp.on('message',b=>{if(b.toString()==='S01 canary')result.udpMarkers++;else if(b.toString()==='receiver self-check')result.selfCheckUdp++;});
Promise.all([new Promise(r=>tcp.listen(46391,'127.0.0.1',r)),new Promise(r=>udp.bind(46392,'127.0.0.1',r))]).then(async()=>{
 await new Promise(r=>{const c=net.connect(46391,'127.0.0.1',()=>{result.selfCheckTcp++;c.end();r();});});
 const client=dgram.createSocket('udp4');client.send(Buffer.from('receiver self-check'),46392,'127.0.0.1',()=>client.close());
 setTimeout(()=>fs.writeFileSync(`${root}/logs/receiver-ready.json`,JSON.stringify({ready:true,...result})),200);
 setTimeout(()=>{result.tcpConnections-=result.selfCheckTcp;result.ended=new Date().toISOString();tcp.close();udp.close();fs.writeFileSync(`${root}/logs/receiver-result.json`,JSON.stringify(result,null,2));},12000);
}).catch(e=>{console.error(e);process.exitCode=1;});
