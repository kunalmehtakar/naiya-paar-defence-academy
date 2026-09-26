const http=require('http');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const DATA_FILE=path.join(__dirname,'students.json');
const FEES_FILE=path.join(__dirname,'course_fees.json');
const ADMIN_FILE=path.join(__dirname,'.admin_credentials');
const GALLERY_FILE=path.join(__dirname,'gallery.json');
const GALLERY_DIR=path.join(__dirname,'gallery');
if(!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR,{recursive:true});
if(!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE,'[]');
if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE,JSON.stringify({students:[]},null,2));


const ADMIN_LOGIN_ATTEMPTS=new Map();
const ADMIN_MAX_ATTEMPTS=5;
const ADMIN_BLOCK_TIME=10*60*1000;

const ADMIN_SESSIONS=new Map();
const SESSION_TTL=30*60*1000;

const STUDENT_LOGIN_RATE_LIMIT=new Map();
const STUDENT_LOGIN_MAX_ATTEMPTS=10;
const STUDENT_LOGIN_WINDOW=10*60*1000;

function checkStudentLoginRateLimit(req){
  const ip=String(
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();

  const now=Date.now();
  const current=STUDENT_LOGIN_RATE_LIMIT.get(ip) || {count:0,windowStart:now};

  if(now-current.windowStart>=STUDENT_LOGIN_WINDOW){
    current.count=0;
    current.windowStart=now;
  }

  current.count++;

  STUDENT_LOGIN_RATE_LIMIT.set(ip,current);

  return current.count<=STUDENT_LOGIN_MAX_ATTEMPTS;
}

const REGISTER_RATE_LIMIT=new Map();
const REGISTER_MAX_REQUESTS=5;
const REGISTER_WINDOW=10*60*1000;

function checkRegisterRateLimit(req){
  const ip=String(
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();

  const now=Date.now();
  const current=REGISTER_RATE_LIMIT.get(ip) || {count:0,windowStart:now};

  if(now-current.windowStart>=REGISTER_WINDOW){
    current.count=0;
    current.windowStart=now;
  }

  current.count++;

  if(current.count>REGISTER_MAX_REQUESTS){
    REGISTER_RATE_LIMIT.set(ip,current);
    return false;
  }

  REGISTER_RATE_LIMIT.set(ip,current);
  return true;
}

function createAdminSession(username){
  const token=crypto.randomBytes(32).toString('hex');
  ADMIN_SESSIONS.set(token,{username,expires:Date.now()+SESSION_TTL});
  return token;
}

function getAdminSession(req){
  const header=String(req.headers.authorization || '');
  if(!header.startsWith('Bearer ')) return null;

  const token=header.slice(7).trim();
  const session=ADMIN_SESSIONS.get(token);

  if(!session) return null;

  if(session.expires<Date.now()){
    ADMIN_SESSIONS.delete(token);
    return null;
  }

  session.expires=Date.now()+SESSION_TTL;
  return session;
}

function requireAdminSession(req,res){
  const session=getAdminSession(req);
  if(!session){
    res.writeHead(401,{'Content-Type':'application/json'});
    res.end(JSON.stringify({success:false,message:'Admin session expired or invalid'}));
    return false;
  }
  return true;
}

function logoutAdminSession(req){
  const header=String(req.headers.authorization || '');
  if(header.startsWith('Bearer ')){
    ADMIN_SESSIONS.delete(header.slice(7).trim());
  }
}

function checkAdmin(req){
  const username=req.headers['x-admin-username'] || '';
  const password=req.headers['x-admin-password'] || '';

  let savedUser=(process.env.ADMIN_USERNAME || '').trim();
  let savedPass=(process.env.ADMIN_PASSWORD || '').trim();

  if(!savedUser || !savedPass){
    try{
      const credentials=fs.readFileSync(ADMIN_FILE,'utf8').split(/\r?\n/);
      savedUser=(credentials[0] || '').trim();
      savedPass=(credentials[1] || '').trim();
    }catch(e){
      return false;
    }
  }

  return username===savedUser && password===savedPass;
}

function readCourseFees(){
  try{
    const fees=JSON.parse(fs.readFileSync(FEES_FILE,'utf8'));
    return fees && typeof fees==='object' ? fees : {};
  }catch(e){
    return {};
  }
}

function saveCourseFees(fees){
  fs.writeFileSync(FEES_FILE,JSON.stringify(fees,null,2));
}


function saveStudent(student){
  let data={students:[]};
  try{data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}
  if(!Array.isArray(data.students)) data.students=[];
  data.students.push(student);
  fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2));
}

const server=http.createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');

  if(req.url==='/sitemap.xml' && req.method==='GET'){
    res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'sitemap.xml'),'utf8'));
  }

  if(req.url==='/robots.txt' && req.method==='GET'){
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'robots.txt'),'utf8'));
  }



  if(req.url==='/api/admin/login' && req.method==='POST'){
    let body='';
    let bodySize=0;
    const MAX_BODY=10*1024;

    req.on('data',chunk=>{
      bodySize+=chunk.length;
      if(bodySize<=MAX_BODY) body+=chunk;
    });

    req.on('end',()=>{
      if(bodySize>MAX_BODY){
        res.writeHead(413,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({success:false,message:'Course fees request too large'}));
      }
      if(bodySize>MAX_BODY){
        res.writeHead(413,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({success:false,message:'Gallery upload too large'}));
      }
      try{
        if(bodySize>MAX_BODY){
          res.writeHead(413,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Request too large'}));
        }

        const login=JSON.parse(body);
        const username=String(login.username || '').trim();
        const password=String(login.password || '');

        const fakeReq={
          headers:{
            'x-admin-username':username,
            'x-admin-password':password
          }
        };

        const ip=String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const now=Date.now();
        const attempt=ADMIN_LOGIN_ATTEMPTS.get(ip) || {count:0,blockedUntil:0};

        if(attempt.blockedUntil>now){
          res.writeHead(429,{'Content-Type':'application/json','Retry-After':String(Math.ceil((attempt.blockedUntil-now)/1000))});
          return res.end(JSON.stringify({success:false,message:'बहुत अधिक login attempts। कुछ मिनट बाद फिर कोशिश करें।'}));
        }

        if(!checkAdmin(fakeReq)){
          attempt.count++;
          if(attempt.count>=ADMIN_MAX_ATTEMPTS){
            attempt.blockedUntil=now+ADMIN_BLOCK_TIME;
            attempt.count=0;
          }
          ADMIN_LOGIN_ATTEMPTS.set(ip,attempt);

          res.writeHead(401,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Invalid admin credentials'}));
        }

        ADMIN_LOGIN_ATTEMPTS.delete(ip);

        const token=createAdminSession(username);

        res.writeHead(200,{
          'Content-Type':'application/json',
          'Cache-Control':'no-store'
        });
        res.end(JSON.stringify({
          success:true,
          message:'Admin login successful',
          token:token
        }));
      }catch(e){
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,message:'Invalid login data'}));
      }
    });
    return;
  }

  if(req.url==='/api/admin/logout' && req.method==='POST'){
    logoutAdminSession(req);
    res.writeHead(200,{
      'Content-Type':'application/json',
      'Cache-Control':'no-store'
    });
    res.end(JSON.stringify({success:true,message:'Logged out'}));
    return;
  }

  if(req.url==='/api/gallery' && req.method==='GET'){
    try{
      const gallery=JSON.parse(fs.readFileSync(GALLERY_FILE,'utf8'));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:true,gallery:Array.isArray(gallery)?gallery:[]}));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Gallery read failed'}));
    }
    return;
  }

  if(req.url==='/api/gallery' && req.method==='POST'){
    if(!requireAdminSession(req,res)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    let bodySize=0;
    const MAX_BODY=2*1024*1024;

    req.on('data',chunk=>{
      bodySize+=chunk.length;
      if(bodySize<=MAX_BODY) body+=chunk;
    });

    req.on('end',()=>{
      try{
        const item=JSON.parse(body);

        if(!item.name || !item.data){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:false,message:'Photo data missing'}));
          return;
        }

        const match=String(item.data).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
        if(!match){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:false,message:'Only JPG, PNG or WebP images are allowed'}));
          return;
        }

        const ext=match[1]==='jpeg' || match[1]==='jpg' ? 'jpg' : match[1];
        const filename='gallery_'+Date.now()+'.'+ext;
        fs.writeFileSync(path.join(GALLERY_DIR,filename),Buffer.from(match[2],'base64'));

        let gallery=[];
        try{
          gallery=JSON.parse(fs.readFileSync(GALLERY_FILE,'utf8'));
          if(!Array.isArray(gallery)) gallery=[];
        }catch(e){}

        const photo={
          id:Date.now().toString(),
          name:String(item.name).trim(),
          file:'/gallery/'+filename,
          date:new Date().toISOString()
        };

        gallery.unshift(photo);
        fs.writeFileSync(GALLERY_FILE,JSON.stringify(gallery,null,2));

        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:true,message:'Photo uploaded successfully',photo:photo}));
      }catch(e){
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,message:'Gallery upload failed'}));
      }
    });
    return;
  }


  if(req.url==='/api/course-fees' && req.method==='GET'){
    const fees=readCourseFees();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({success:true,fees:fees}));
    return;
  }

  if(req.url==='/api/course-fees' && req.method==='POST'){
    if(!requireAdminSession(req,res)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    let bodySize=0;
    const MAX_BODY=1024*1024;

    req.on('data',chunk=>{
      bodySize+=chunk.length;
      if(bodySize<=MAX_BODY) body+=chunk;
    });

    req.on('end',()=>{
      try{
        const fees=JSON.parse(body);

        if(!fees || typeof fees!=='object' || Array.isArray(fees)){
          res.writeHead(400,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Invalid course fees data'}));
        }

        const keys=Object.keys(fees);
        if(keys.length>50){
          res.writeHead(400,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Too many courses'}));
        }

        for(const key of keys){
          if(!key.trim() || key.length>100){
            res.writeHead(400,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({success:false,message:'Invalid course name'}));
          }

          const value=fees[key];
          if(typeof value!=='number' || !Number.isFinite(value) || value<0 || value>1000000){
            res.writeHead(400,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({success:false,message:'Invalid course fee'}));
          }
        }

        saveCourseFees(fees);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:true,message:'Course fees updated',fees:fees}));
      }catch(e){
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,message:'Invalid fee data'}));
      }
    });
    return;
  }


  if(req.url==='/api/payment-status' && req.method==='POST'){
    if(!requireAdminSession(req,res)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    let bodySize=0;
    const MAX_BODY=10*1024;

    req.on('data',chunk=>{
      bodySize+=chunk.length;
      if(bodySize<=MAX_BODY) body+=chunk;
    });

    req.on('end',()=>{
      try{
        if(bodySize>MAX_BODY){
          res.writeHead(413,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Payment request too large'}));
        }

        const {id,paymentStatus}=JSON.parse(body);

        if(!id || !['Paid','Pending'].includes(paymentStatus)){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:false,message:'Invalid payment data'}));
          return;
        }

        const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
        const students=Array.isArray(data.students)?data.students:[];

        const index=students.findIndex(st=>st.id===id);

        if(index===-1){
          res.writeHead(404,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:false,message:'Student not found'}));
          return;
        }

        students[index].paymentStatus=paymentStatus;

        if(paymentStatus==='Paid'){
          students[index].paymentDate=new Date().toISOString();
          students[index].paymentVerifiedAt=new Date().toISOString();
        }else{
          students[index].paymentVerifiedAt=null;
        }

        fs.writeFileSync(DATA_FILE,JSON.stringify({students:students},null,2));

        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({
          success:true,
          message:paymentStatus==='Paid'
            ? 'Payment verified successfully'
            : 'Payment changed to Pending'
        }));

      }catch(e){
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,message:'Payment status update failed'}));
      }
    });
    return;
  }

  if(req.url==='/api/delete-student' && req.method==='POST'){
    if(!requireAdminSession(req,res)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    let bodySize=0;
    const MAX_BODY=10*1024;

    req.on('data',chunk=>{
      bodySize+=chunk.length;
      if(bodySize<=MAX_BODY) body+=chunk;
    });

    req.on('end',()=>{
      try{
        if(bodySize>MAX_BODY){
          res.writeHead(413,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Delete request too large'}));
        }

        const {id}=JSON.parse(body);

        if(typeof id!=='string' || !id.trim() || id.length>50){
          res.writeHead(400,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Invalid student ID'}));
        }
        const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
        const students=Array.isArray(data.students)?data.students:[];
        const newStudents=students.filter(st=>st.id!==id);

        if(newStudents.length===students.length){
          res.writeHead(404,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:false,message:'Student not found'}));
          return;
        }

        fs.writeFileSync(DATA_FILE,JSON.stringify({students:newStudents},null,2));
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:true,message:'Student deleted successfully'}));
      }catch(e){
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,message:'Delete failed'}));
      }
    });
    return;
  }

  if(req.url==='/api/students' && req.method==='GET'){
    if(!requireAdminSession(req,res)){
      return;
    }
    try{
      const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      const students=Array.isArray(data.students)?data.students:[];
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:true,students:students}));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Students data read failed'}));
    }
    return;
  }

  if(req.url==='/api/login' && req.method==='POST'){
  if(!checkStudentLoginRateLimit(req)){
    res.writeHead(429,{
      'Content-Type':'application/json',
      'Retry-After':'600'
    });
    return res.end(JSON.stringify({
      success:false,
      message:'बहुत अधिक login attempts। कुछ मिनट बाद फिर कोशिश करें।'
    }));
  }

  let body='';
  let bodySize=0;
  const MAX_BODY=10*1024;

  req.on('data',chunk=>{
    bodySize+=chunk.length;
    if(bodySize<=MAX_BODY) body+=chunk;
  });

  req.on('end',()=>{
    try{
      if(bodySize>MAX_BODY){
        res.writeHead(413,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({success:false,message:'Login request too large'}));
      }

      const login=JSON.parse(body);
      const id=String(login.id || '').trim();
      const mobile=String(login.mobile || '').trim();

      if(!id || !mobile || id.length>50 || mobile.length>15 || !/^[0-9+ -]+$/.test(mobile)){
        res.writeHead(400,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({success:false,message:'Invalid login data'}));
      }

      const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      const students=Array.isArray(data.students)?data.students:[];

      const student=students.find(x=>
        String(x.id).trim()===id &&
        String(x.mobile).trim()===mobile
      );

      res.writeHead(200,{
        'Content-Type':'application/json',
        'Cache-Control':'no-store'
      });

      if(student){
        res.end(JSON.stringify({success:true,student:student}));
      }else{
        res.end(JSON.stringify({success:false,message:'Student ID या Mobile Number गलत है'}));
      }
    }catch(e){
      res.writeHead(400,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Invalid data'}));
    }
  });
  return;
}

if(req.url==='/api/register' && req.method==='POST'){
    if(!checkRegisterRateLimit(req)){
      res.writeHead(429,{
        'Content-Type':'application/json',
        'Retry-After':'600'
      });
      return res.end(JSON.stringify({
        success:false,
        message:'बहुत अधिक registration requests। कुछ मिनट बाद फिर कोशिश करें।'
      }));
    }
    let body='';
    let bodySize=0;
    const MAX_BODY=100*1024;

    req.on('data',chunk=>{
      bodySize+=chunk.length;
      if(bodySize<=MAX_BODY) body+=chunk;
    });

    req.on('end',()=>{
      try{
        if(bodySize>MAX_BODY){
          res.writeHead(413,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Request too large'}));
        }

        const input=JSON.parse(body);
        const name=String(input.name || '').trim();
        const mobile=String(input.mobile || '').trim();

        if(!name || !mobile){
          res.writeHead(400,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Required data missing'}));
        }

        const father=String(input.father || '').trim();
        const dob=String(input.dob || '').trim();
        const course=String(input.course || '').trim();
        const address=String(input.address || '').trim();

        if(
          name.length>100 ||
          father.length>100 ||
          mobile.length>15 ||
          dob.length>20 ||
          course.length>100 ||
          address.length>300 ||
          !/^[0-9+ -]+$/.test(mobile)
        ){
          res.writeHead(400,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Invalid registration data'}));
        }

        const photo=typeof input.photo === 'string' ? input.photo.trim() : '';
        if(photo){
          const photoPattern=/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i;
          if(!photoPattern.test(photo) || photo.length>80*1024){
            res.writeHead(400,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({success:false,message:'Invalid or oversized photo'}));
          }
        }
        let data={students:[]};
        try{data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}
        if(!Array.isArray(data.students)) data.students=[];

        const mobileExists=data.students.some(st=>
          String(st.mobile || '').trim()===mobile
        );

        if(mobileExists){
          res.writeHead(409,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({
            success:false,
            message:'इस Mobile Number से पहले ही registration मौजूद है'
          }));
        }

        const student={
          id:'ACA'+Date.now().toString().slice(-6)+crypto.randomBytes(2).toString('hex').toUpperCase(),
          name:name,
          father:father,
          mobile:mobile,
          dob:dob,
          course:course,
          address:address,
          photo:photo
        };

        data.students.push(student);

        fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2));

        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({
          success:true,
          message:'Registration saved',
          student:student
        }));
      }catch(e){
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,message:'Invalid data'}));
      }
    });
    return;
  }
if(req.url==='/registration'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!DOCTYPE html>
<html lang="hi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Student Registration</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;font-family:Arial;color:#172033}
header{background:#071b3a;color:white;padding:18px;font-size:21px;font-weight:bold}
.box{margin:18px auto;background:white;padding:20px;border-radius:18px;max-width:600px;box-shadow:0 4px 18px #0001}
h2{margin-top:0}.group{margin-bottom:15px}label{display:block;font-weight:bold;margin-bottom:7px}
input,select{width:100%;padding:13px;border:1px solid #ccd2dc;border-radius:9px;font-size:15px}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#0b62c6;color:white;font-size:17px;font-weight:bold}
.back{display:inline-block;margin-bottom:18px;color:#0b62c6;text-decoration:none}
</style>
</head>
<body>
<header>🎓 Student Registration Portal</header>
<div class="box">
<a class="back" href="/">← Back to Website</a>
<h2>Student Registration</h2>
<form onsubmit="register(event)">
<div class="group"><label>Student Name</label><input id="name" required></div>
<div class="group"><label>Father's Name</label><input id="father" required></div>
<div class="group"><label>Date of Birth</label><input id="dob" type="date" required></div>
<div class="group"><label>Mobile Number</label><input id="mobile" type="tel" required></div>
<div class="group"><label>Course</label>
<select id="course" required>
<option value="">Select Course</option>
<option>SSC GD</option>
<option>Bihar Police</option>
</select></div>
<div class="group"><label>Address</label><input id="address" required></div>
<button type="submit">Submit Registration</button>
</form>
</div>
<script>
function register(e){
 e.preventDefault();
 alert("Registration form received. Payment and Student ID system will be connected next.");
}
</script>
</body>
</html>`);
    return;
  }

  if(req.url==='/academy-logo.jpg'){
    const logoPath=path.join(__dirname,'public','academy-logo.jpg');
    try{
      const logo=fs.readFileSync(logoPath);
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-cache'});
      res.end(logo);
    }catch(e){
      res.writeHead(404,{'Content-Type':'text/plain'});
      res.end('Logo not found');
    }
    return;
  }

  if(req.url==='/.admin_credentials' || req.url.startsWith('/.admin_credentials?')){
    res.writeHead(404,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({success:false,message:'Not found'}));
  }

  if(req.url==='/students.json' || req.url.startsWith('/students.json?')){
    res.writeHead(404,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({success:false,message:'Not found'}));
  }

  const blockedPath=req.url.split('?')[0];
  if(
    blockedPath==='/.env' ||
    blockedPath.startsWith('/.env.') ||
    blockedPath.startsWith('/server.js.backup') ||
    blockedPath.startsWith('/server_backup_security_') ||
    blockedPath.includes('.backup')
  ){
    res.writeHead(404,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({success:false,message:'Not found'}));
  }

  if(req.url.startsWith('/api/')){
    res.writeHead(404,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({success:false,message:'API endpoint not found'}));
  }

  if(req.method!=='GET'){
    res.writeHead(405,{
      'Content-Type':'application/json',
      'Allow':'GET, POST'
    });
    return res.end(JSON.stringify({success:false,message:'Method not allowed'}));
  }

  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(fs.readFileSync(path.join(__dirname,'index.html')));
});

server.listen(process.env.PORT || 3000,()=>console.log('Academy Website: http://localhost:3000'));
