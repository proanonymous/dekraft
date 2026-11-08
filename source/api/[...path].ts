import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { put } from '@vercel/blob';
import { timingSafeEqual } from 'node:crypto';

const seed = [
 {id:'product_1',name:'Golden Hour Waist Beads',category:'Waist Beads',price:8500,description:'Warm gold and amber tones made for everyday elegance.',image:'https://images.unsplash.com/photo-1617038220319-276d3cfab638?auto=format&fit=crop&w=900&q=85',tag:'Bestseller',stock:12},
 {id:'product_2',name:'Ocean Muse Bracelet',category:'Bracelets',price:6500,description:'A refined blue-bead accent inspired by deep ocean hues.',image:'https://images.unsplash.com/photo-1573408301185-9146fe634ad0?auto=format&fit=crop&w=900&q=85',tag:'New',stock:10},
 {id:'product_3',name:'Pearl Essence Necklace',category:'Necklaces',price:12000,description:'Soft pearl details for a timeless, graceful finish.',image:'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=900&q=85',stock:8},
 {id:'product_4',name:'Earthline Anklet',category:'Anklets',price:5000,description:'Understated, earthy colour with a handcrafted feel.',image:'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=85',stock:14},
 {id:'product_5',name:'Soft Glow Earrings',category:'Earrings',price:7500,description:'Light-catching details to finish your favourite look.',image:'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=900&q=85',stock:9},
 {id:'product_6',name:'Custom Colour Waist Beads',category:'Custom-made',price:10000,description:'Your colour story, your style. Request a made-for-you design.',image:'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=85',tag:'Made for you',stock:20}
];
const clean=(v:unknown,n=500)=>typeof v==='string'?v.trim().slice(0,n):'';
const emailOK=(v:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const db=()=>{if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is missing. Connect a Neon database in Vercel.');return neon(process.env.DATABASE_URL);};
let ready:Promise<void>|undefined;
async function init(){
 if(!ready)ready=(async()=>{
  const s=db();
  await s.query('CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,price NUMERIC NOT NULL,description TEXT NOT NULL,image TEXT NOT NULL,image_path TEXT,tag TEXT,stock INTEGER NOT NULL DEFAULT 0,active BOOLEAN NOT NULL DEFAULT TRUE)');
  await s.query('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY,customer_name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,items JSONB NOT NULL,total NUMERIC NOT NULL,status TEXT NOT NULL,payment_status TEXT NOT NULL,payment_reference TEXT,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL)');
  for(const p of seed)await s.query('INSERT INTO products(id,name,category,price,description,image,tag,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE) ON CONFLICT(id) DO NOTHING',[p.id,p.name,p.category,p.price,p.description,p.image,p.tag||null,p.stock]);
 })().catch(e=>{ready=undefined;throw e;});
 return ready;
}
function isAdmin(body:any){
 const a=Buffer.from(process.env.STORE_ADMIN_PASSWORD||''),b=Buffer.from(clean(body?.adminPassword,500));
 return a.length>=12&&a.length===b.length&&timingSafeEqual(a,b);
}
const product=(r:any)=>({id:r.id,name:r.name,category:r.category,price:Number(r.price),description:r.description,image:r.image_path||r.image,imagePath:r.image_path||undefined,tag:r.tag||undefined,stock:Number(r.stock),active:Boolean(r.active)});
const order=(r:any)=>({id:r.id,customerName:r.customer_name,email:r.email,phone:r.phone,address:r.address,items:r.items,total:Number(r.total),status:r.status,paymentStatus:r.payment_status,paymentReference:r.payment_reference||undefined,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()});
const fail=(res:VercelResponse,status:number,message:string)=>res.status(status).json({error:message});

export default async function handler(req:VercelRequest,res:VercelResponse){
 res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS')return res.status(204).end();
 const path=(req.url||'/').split('?')[0].replace(/\/+$/,'')||'/';
 try{
  await init();const s=db(),b=req.body||{};
  if(path==='/api/_healthcheck'&&req.method==='GET')return res.status(200).json({ok:true,database:'connected'});
  if(path==='/api/products'&&req.method==='GET'){
   const rows=await s.query('SELECT * FROM products WHERE active=TRUE ORDER BY id');
   return res.status(200).json({products:rows.map(product)});
  }
  if(path==='/api/payments/status'&&req.method==='GET')return res.status(200).json({configured:Boolean(process.env.PAYSTACK_SECRET_KEY)});
  if(path==='/api/admin/login'&&req.method==='POST'){
   if((process.env.STORE_ADMIN_PASSWORD||'').length<12)return fail(res,503,'Set STORE_ADMIN_PASSWORD in Vercel (minimum 12 characters).');
   return isAdmin(b)?res.status(200).json({ok:true}):fail(res,401,'Incorrect store admin password.');
  }
  if(path==='/api/orders'&&req.method==='POST'){
   const name=clean(b.customerName,120),email=clean(b.email,254).toLowerCase(),phone=clean(b.phone,40),address=clean(b.address,600),raw=Array.isArray(b.items)?b.items:[];
   if(!name||!emailOK(email)||!phone||!address||!raw.length||raw.length>30)return fail(res,400,'Enter valid contact and delivery details and at least one product.');
   const ids=raw.map((x:any)=>clean(x.productId,100)),qty=raw.map((x:any)=>Number(x.quantity));
   if(qty.some((n:number)=>!Number.isInteger(n)||n<1||n>50))return fail(res,400,'Each quantity must be between 1 and 50.');
   const rows=await s.query('SELECT * FROM products WHERE id=ANY($1) AND active=TRUE',[ids]);
   const map=new Map(rows.map((r:any)=>[r.id,r])),items:any[]=[];
   for(let i=0;i<ids.length;i++){const p:any=map.get(ids[i]);if(!p)return fail(res,400,'A selected product is unavailable.');if(Number(p.stock)<qty[i])return fail(res,409,'Not enough stock for '+p.name+'.');items.push({productId:p.id,name:p.name,price:Number(p.price),quantity:qty[i]});}
   const total=items.reduce((n,x)=>n+x.price*x.quantity,0),id='order_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10),now=new Date().toISOString();
   await s.query('INSERT INTO orders(id,customer_name,email,phone,address,items,total,status,payment_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$10)',[id,name,email,phone,address,JSON.stringify(items),total,'pending','unpaid',now]);
   return res.status(201).json({orderId:id,total,currency:'NGN'});
  }
  if(path==='/api/admin/images/upload'&&req.method==='POST'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   if(!process.env.BLOB_READ_WRITE_TOKEN)return fail(res,503,'Connect Vercel Blob to enable product image uploads.');
   const type=clean(b.contentType,80),data=clean(b.data,7000000),m=data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
   if(!['image/jpeg','image/png','image/webp'].includes(type)||!m||m[1]!==type)return fail(res,400,'Choose a valid JPG, PNG or WebP image.');
   const bytes=Buffer.from(m[2],'base64');if(bytes.length>5*1024*1024)return fail(res,413,'Image must be smaller than 5 MB.');
   const ext=type==='image/jpeg'?'jpg':type==='image/png'?'png':'webp';
   const blob=await put('product-images/'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)+'.'+ext,bytes,{access:'public',contentType:type});
   return res.status(201).json({imagePath:blob.url,image:blob.url});
  }
  if(path==='/api/admin/products/list'&&req.method==='POST'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   const rows=await s.query('SELECT * FROM products ORDER BY id');return res.status(200).json({products:rows.map(product)});
  }
  if(path==='/api/admin/orders/list'&&req.method==='POST'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   const rows=await s.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');return res.status(200).json({orders:rows.map(order)});
  }
  if(path==='/api/admin/products'&&req.method==='POST'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   const name=clean(b.name,160),category=clean(b.category,80),description=clean(b.description,600),price=Number(b.price),stock=Number(b.stock),image=clean(b.image,1200),imagePath=clean(b.imagePath,1200);
   if(!name||!category||!description||!Number.isFinite(price)||price<0||!Number.isInteger(stock)||stock<0)return fail(res,400,'Enter a name, category, description, valid price and stock.');
   const id='product_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8),photo=imagePath.startsWith('https://')?imagePath:(image.startsWith('https://')?image:'https://images.unsplash.com/photo-1617038220319-276d3cfab638?auto=format&fit=crop&w=900&q=85');
   await s.query('INSERT INTO products(id,name,category,price,description,image,image_path,tag,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)',[id,name,category,price,description,photo,imagePath||null,clean(b.tag,50)||null,stock]);
   return res.status(201).json({product:{id,name,category,price,description,image:photo,imagePath:imagePath||undefined,tag:clean(b.tag,50),stock,active:true}});
  }
  const pm=path.match(/^\/api\/admin\/products\/([^/]+)$/);
  if(pm&&req.method==='PUT'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   const id=decodeURIComponent(pm[1]),name=clean(b.name,160),category=clean(b.category,80),description=clean(b.description,600),price=Number(b.price),stock=Number(b.stock),image=clean(b.image,1200),imagePath=clean(b.imagePath,1200);
   if(!name||!category||!description||!Number.isFinite(price)||price<0||!Number.isInteger(stock)||stock<0)return fail(res,400,'Enter a name, category, description, valid price and stock.');
   const [old]:any[]=await s.query('SELECT * FROM products WHERE id=$1 LIMIT 1',[id]);if(!old)return fail(res,404,'Product was not found.');
   const photo=imagePath.startsWith('https://')?imagePath:(image.startsWith('https://')?image:old.image);
   const [saved]:any[]=await s.query('UPDATE products SET name=$2,category=$3,price=$4,description=$5,image=$6,image_path=$7,tag=$8,stock=$9,active=$10 WHERE id=$1 RETURNING *',[id,name,category,price,description,photo,imagePath||null,clean(b.tag,50)||null,stock,b.active!==false]);
   return res.status(200).json({product:product(saved)});
  }
  if(pm&&req.method==='DELETE'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   const rows=await s.query('DELETE FROM products WHERE id=$1 RETURNING id',[decodeURIComponent(pm[1])]);
   return rows.length?res.status(200).json({deleted:true}):fail(res,404,'Product was not found.');
  }
  const om=path.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if(om&&req.method==='PUT'){
   if(!isAdmin(b))return fail(res,401,'Store administrator access denied.');
   const status=clean(b.status,40);if(!['pending','processing','shipped','completed','cancelled'].includes(status))return fail(res,400,'Invalid order status.');
   const [saved]:any[]=await s.query('UPDATE orders SET status=$2,updated_at=$3 WHERE id=$1 RETURNING *',[decodeURIComponent(om[1]),status,new Date().toISOString()]);
   return saved?res.status(200).json({order:order(saved)}):fail(res,404,'Order was not found.');
  }
  const vm=path.match(/^\/api\/payments\/verify\/([^/]+)$/);
  if(vm&&req.method==='GET'){
   const ref=decodeURIComponent(vm[1]),[o]:any[]=await s.query('SELECT * FROM orders WHERE id=$1 LIMIT 1',[ref]);
   if(!o)return fail(res,404,'Order reference was not found.');if(o.payment_status==='paid')return res.status(200).json({paid:true,orderId:o.id});
   const key=process.env.PAYSTACK_SECRET_KEY;if(!key)return fail(res,503,'Payment verification is not configured. Contact the store.');
   const upstream=await fetch('https://api.paystack.co/transaction/verify/'+encodeURIComponent(ref),{headers:{Authorization:'Bearer '+key}}),result:any=await upstream.json();
   if(!upstream.ok||!result.status||!result.data)return fail(res,502,result.message||'Payment could not be verified.');
   const paid=result.data.status==='success'&&result.data.currency==='NGN'&&Number(result.data.amount)===Math.round(Number(o.total)*100)&&result.data.reference===o.id;
   if(paid)await s.query("UPDATE orders SET payment_status='paid',status=CASE WHEN status='pending' THEN 'processing' ELSE status END,updated_at=$2 WHERE id=$1",[o.id,new Date().toISOString()]);
   return res.status(200).json({paid,orderId:o.id});
  }
  return fail(res,404,'API route not found.');
 }catch(error){
  console.error('Dé Kraft API error:',error);
  const msg=error instanceof Error?error.message:'Unexpected server error.';
  return fail(res,500,msg.includes('DATABASE_URL')?msg:'The store service is unavailable. Check Vercel function logs.');
 }
}
