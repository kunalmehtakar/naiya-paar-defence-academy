const http=require('http');
const fs=require('fs');
const path=require('path');
const DATA_FILE=path.join(__dirname,'students.json');
const FEES_FILE=path.join(__dirname,'course_fees.json');
const ADMIN_FILE=path.join(__dirname,'.admin_credentials');
const GALLERY_FILE=path.join(__dirname,'gallery.json');
const GALLERY_DIR=path.join(__dirname,'gallery');
if(!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR,{recursive:true});
if(!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE,'[]');

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
  if(req.url==='/sitemap.xml' && req.method==='GET'){
    res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'sitemap.xml'),'utf8'));
  }

  if(req.url==='/robots.txt' && req.method==='GET'){
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'robots.txt'),'utf8'));
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
    if(!checkAdmin(req)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    req.on('data',chunk=>body+=chunk);
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
    if(!checkAdmin(req)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      try{
        const fees=JSON.parse(body);
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
    const adminPassword=req.headers['x-admin-password'];

    if(!checkAdmin(req)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    req.on('data',chunk=>body+=chunk);

    req.on('end',()=>{
      try{
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
    if(!checkAdmin(req)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
      return;
    }

    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      try{
        const {id}=JSON.parse(body);
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
    if(!checkAdmin(req)){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({success:false,message:'Admin login required'}));
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
  let body='';
  req.on('data',chunk=>body+=chunk);
  req.on('end',()=>{
    try{
      const login=JSON.parse(body);
      const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      const students=Array.isArray(data.students)?data.students:[];
      const student=students.find(x=>
        String(x.id).trim()===String(login.id).trim() &&
        String(x.mobile).trim()===String(login.mobile).trim()
      );

      res.writeHead(200,{'Content-Type':'application/json'});
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
    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      try{
        const student=JSON.parse(body);
        if(!student.id || !student.name || !student.mobile){
          res.writeHead(400,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,message:'Required data missing'}));
        }
        let data={students:[]};
        try{data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}
        if(!Array.isArray(data.students)) data.students=[];

        const index=data.students.findIndex(x=>x.id===student.id);
        if(index>=0){
          data.students[index]={...data.students[index],...student};
        }else{
          data.students.push(student);
        }

        fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2));
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:true,message:'Registration saved'}));
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

  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(fs.readFileSync(path.join(__dirname,'index.html')));
});

server.listen(process.env.PORT || 3000,()=>console.log('Academy Website: http://localhost:3000'));
