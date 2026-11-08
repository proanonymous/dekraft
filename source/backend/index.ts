import { db, router, json, error, secrets, storage } from '@appdeploy/sdk';

type ProductRecord = { id: string; name: string; category: string; price: number; description: string; image: string; imagePath?: string; tag?: string; stock: number; active: boolean };
type OrderItem = { productId: string; name: string; price: number; quantity: number };
type OrderRecord = { id: string; customerName: string; email: string; phone: string; address: string; items: OrderItem[]; total: number; status: string; paymentStatus: string; paymentReference?: string; createdAt: string; updatedAt: string };
const seed: ProductRecord[] = [
  {id:'product_1',name:'Golden Hour Waist Beads',category:'Waist Beads',price:8500,description:'Warm gold and amber tones made for everyday elegance.',image:'https://images.unsplash.com/photo-1617038220319-276d3cfab638?auto=format&fit=crop&w=900&q=85',tag:'Bestseller',stock:12,active:true},
  {id:'product_2',name:'Ocean Muse Bracelet',category:'Bracelets',price:6500,description:'A refined blue-bead accent inspired by deep ocean hues.',image:'https://images.unsplash.com/photo-1573408301185-9146fe634ad0?auto=format&fit=crop&w=900&q=85',tag:'New',stock:10,active:true},
  {id:'product_3',name:'Pearl Essence Necklace',category:'Necklaces',price:12000,description:'Soft pearl details for a timeless, graceful finish.',image:'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=900&q=85',stock:8,active:true},
  {id:'product_4',name:'Earthline Anklet',category:'Anklets',price:5000,description:'Understated, earthy colour with a handcrafted feel.',image:'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=85',stock:14,active:true},
  {id:'product_5',name:'Soft Glow Earrings',category:'Earrings',price:7500,description:'Light-catching details to finish your favourite look.',image:'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=900&q=85',stock:9,active:true},
  {id:'product_6',name:'Custom Colour Waist Beads',category:'Custom-made',price:10000,description:'Your colour story, your style. Request a made-for-you design.',image:'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=85',tag:'Made for you',stock:20,active:true}
];
async function ensureProducts(){const ids=seed.map(p=>p.id);const current=await db.get<ProductRecord>('products',ids,{consistent:true});const missing=seed.filter((_,i)=>!current[i]);if(missing.length)await db.tx.add('products',missing);}
async function products(){
  await ensureProducts();
  const records=(await db.list<ProductRecord>('products',{limit:100})).items;
  const paths=records.filter(p=>p.imagePath).map(p=>p.imagePath as string);
  if(!paths.length)return records;
  const signed=await storage.url(paths);
  const urls=new Map(signed.map(item=>[item.path,item.url]));
  return records.map(p=>p.imagePath&&urls.has(p.imagePath)?{...p,image:urls.get(p.imagePath) as string}:p);
}
async function paystackSecret(){const names=await secrets.listSecretNames();return names.includes('PAYSTACK_SECRET_KEY')?secrets.readSecret('PAYSTACK_SECRET_KEY'):null;}
const str=(v:unknown,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const emailOK=(v:unknown):v is string=>typeof v==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
async function adminPasswordMatches(body: unknown): Promise<boolean> {
  try {
    const provided = str((body as Record<string, unknown> | null)?.adminPassword, 500);
    if (!provided) return false;
    const names = await secrets.listSecretNames();
    if (!names.includes('STORE_ADMIN_PASSWORD')) return false;
    const expected = await secrets.readSecret('STORE_ADMIN_PASSWORD');
    return expected.length >= 12 && provided === expected;
  } catch {
    return false;
  }
}
export const handler=router({
  'GET /api/_healthcheck':[async()=>json({ok:true})],
  'GET /api/products':[async()=>{try{return json({products:(await products()).filter(p=>p.active!==false)});}catch(e){console.error('Catalogue unavailable',e);return error('Product catalogue temporarily unavailable.',503);}}],
  'GET /api/payments/status':[async()=>{try{return json({configured:Boolean(await paystackSecret())});}catch{return json({configured:false});}}],
  'POST /api/orders':[async({body})=>{
    const b=(body??{}) as Record<string,unknown>,customerName=str(b.customerName,120),email=str(b.email,254).toLowerCase(),phone=str(b.phone,40),address=str(b.address,600),raw=Array.isArray(b.items)?b.items:[];
    if(!customerName||!emailOK(email)||!phone||!address||raw.length<1||raw.length>30)return error('Enter valid contact and delivery details and at least one product.',400);
    const ids=raw.map(x=>str((x as Record<string,unknown>).productId,100)),qty=raw.map(x=>Number((x as Record<string,unknown>).quantity));
    if(qty.some(q=>!Number.isInteger(q)||q<1||q>50))return error('Each quantity must be between 1 and 50.',400);
    const unique=[...new Set(ids)],fetched=await db.get<ProductRecord>('products',unique,{consistent:true}),byId=new Map(unique.map((id,i)=>[id,fetched[i]])),items:OrderItem[]=[];
    for(let i=0;i<ids.length;i++){const p=byId.get(ids[i]);if(!p||p.active===false)return error('A selected product is no longer available.',400);if(p.stock<qty[i])return error('Not enough stock for '+p.name+'.',409);items.push({productId:p.id,name:p.name,price:p.price,quantity:qty[i]});}
    const total=items.reduce((sum,x)=>sum+x.price*x.quantity,0),id='order_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10),now=new Date().toISOString();
    const record:OrderRecord={id,customerName,email,phone,address,items,total,status:'pending',paymentStatus:'unpaid',createdAt:now,updatedAt:now};
    const [saved]=await db.tx.add('orders',[record]);if(!saved)return error('Could not save order. Please try again.',503);return json({orderId:id,total,currency:'NGN'},201);
  }],
  'POST /api/payments/initialize':[async({body})=>{
    const id=str(((body??{}) as Record<string,unknown>).orderId,120);if(!id)return error('Order reference is required.',400);
    const [order]=await db.get<OrderRecord>('orders',[id],{consistent:true});if(!order)return error('Order was not found.',404);
    let key:string|null;try{key=await paystackSecret();}catch{key=null;}if(!key)return json({configured:false,orderId:id,message:'Online payment is not configured yet.'});
    const response=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({email:order.email,amount:Math.round(order.total*100),currency:'NGN',reference:order.id,callback_url:'https://de-kraft-essentials-9x5k3n.v2.appdeploy.ai/?payment=verify'})});
    const data=await response.json() as {status?:boolean;message?:string;data?:{authorization_url?:string;reference?:string}};
    if(!response.ok||!data.status||!data.data?.authorization_url)return error(data.message||'Payment could not be started.',502);
    await db.update('orders',[{id:order.id,record:{...order,paymentReference:data.data.reference||order.id,updatedAt:new Date().toISOString()}}]);
    return json({authorizationUrl:data.data.authorization_url,reference:data.data.reference||order.id});
  }],
  'GET /api/payments/verify/:reference':[async({params})=>{
    const ref=str(params.reference,120);if(!ref)return error('Payment reference is required.',400);const [order]=await db.get<OrderRecord>('orders',[ref],{consistent:true});if(!order)return error('Order reference was not found.',404);if(order.paymentStatus==='paid')return json({paid:true,orderId:order.id});
    let key:string|null;try{key=await paystackSecret();}catch{key=null;}if(!key)return error('Payment verification is not configured. Contact the store.',503);
    const response=await fetch('https://api.paystack.co/transaction/verify/'+encodeURIComponent(ref),{headers:{Authorization:'Bearer '+key}}),data=await response.json() as {status?:boolean;message?:string;data?:{status?:string;amount?:number;currency?:string;reference?:string}};
    if(!response.ok||!data.status||!data.data)return error(data.message||'Payment could not be verified.',502);
    const paid=data.data.status==='success'&&data.data.currency==='NGN'&&data.data.amount===Math.round(order.total*100)&&data.data.reference===order.id;
    const updated:OrderRecord={...order,paymentStatus:paid?'paid':order.paymentStatus,status:paid&&order.status==='pending'?'processing':order.status,updatedAt:new Date().toISOString()};await db.update('orders',[{id:order.id,record:updated}]);return json({paid,orderId:order.id});
  }],
  'POST /api/admin/login':[async({body})=>{
    try {
      const names = await secrets.listSecretNames();
      if (!names.includes('STORE_ADMIN_PASSWORD')) return error('Store admin password is not configured yet. Complete the secure password setup first.',503);
      const expected = await secrets.readSecret('STORE_ADMIN_PASSWORD');
      if (expected.length < 12) return error('The store admin password must be at least 12 characters. Set a stronger password in the secure setup form.',503);
      const candidate = str((body as Record<string, unknown> | null)?.adminPassword,500);
      if (!candidate || candidate !== expected) return error('Incorrect store admin password.',401);
      return json({ok:true});
    } catch { return error('Store sign-in is temporarily unavailable.',503); }
  }],
  'POST /api/admin/images/upload':[async({body})=>{
    if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);
    const b=(body??{}) as Record<string,unknown>,data=str(b.data,7_000_000),contentType=str(b.contentType,80);
    if(!['image/jpeg','image/png','image/webp'].includes(contentType))return error('Choose a JPG, PNG or WebP image.',400);
    const match=data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!match||match[1]!==contentType)return error('The selected image could not be read. Please try another image.',400);
    if(match[2].length>6_500_000)return error('Please choose an image smaller than 5 MB.',413);
    const ext=contentType==='image/jpeg'?'jpg':contentType==='image/png'?'png':'webp';
    const path='product-images/'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)+'.'+ext;
    const [ok]=await storage.write([{path,content:match[2],contentType}]);
    if(!ok)return error('Image upload failed. Please try again.',503);
    const [entry]=await storage.url([path]);
    if(!entry?.url)return error('Image uploaded but its preview could not be prepared.',503);
    return json({imagePath:path,image:entry.url},201);
  }],
  'POST /api/admin/products/list':[async({body})=>{if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);return json({products:await products()});}],
  'POST /api/admin/products':[async({body})=>{
    if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);
    const b=(body??{}) as Record<string,unknown>,name=str(b.name,160),category=str(b.category,80),description=str(b.description,600),price=Number(b.price),stock=Number(b.stock),image=str(b.image,1200),imagePath=str(b.imagePath,300);
    if(!name||!category||!description||!Number.isFinite(price)||price<0||!Number.isInteger(stock)||stock<0)return error('Provide a name, category, description, valid price and stock.',400);
    if(imagePath&&!imagePath.startsWith('product-images/'))return error('Invalid product image path.',400);
    const record:ProductRecord={id:'product_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8),name,category,description,price,stock,image:image.startsWith('https://')?image:seed[0].image,imagePath:imagePath||undefined,tag:str(b.tag,50),active:true};
    const [saved]=await db.tx.add('products',[record]);if(!saved)return error('Could not save product.',503);return json({product:record},201);
  }],
  'PUT /api/admin/products/:id':[async({params,body})=>{
    if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);
    const id=str(params.id,120),[old]=await db.get<ProductRecord>('products',[id],{consistent:true});if(!old)return error('Product was not found.',404);
    const b=(body??{}) as Record<string,unknown>,name=str(b.name,160),category=str(b.category,80),description=str(b.description,600),price=Number(b.price),stock=Number(b.stock),image=str(b.image,1200),imagePath=str(b.imagePath,300);
    if(!name||!category||!description||!Number.isFinite(price)||price<0||!Number.isInteger(stock)||stock<0)return error('Provide a name, category, description, valid price and stock.',400);
    if(imagePath&&!imagePath.startsWith('product-images/'))return error('Invalid product image path.',400);
    const record:ProductRecord={...old,name,category,description,price,stock,image:image.startsWith('https://')?image:old.image,imagePath:imagePath||undefined,tag:str(b.tag,50),active:b.active!==false};const [ok]=await db.update('products',[{id,record}]);return ok?json({product:record}):error('Product could not be updated.',503);
  }],
  'DELETE /api/admin/products/:id':[async({params,body})=>{if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);const [ok]=await db.delete('products',[str(params.id,120)]);return ok?json({deleted:true}):error('Product not found or already removed.',404);}],
  'POST /api/admin/orders/list':[async({body})=>{if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);const r=await db.list<OrderRecord>('orders',{limit:100});return json({orders:r.items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});}],
  'PUT /api/admin/orders/:id':[async({params,body})=>{
    if(!await adminPasswordMatches(body))return error('Store administrator access denied.',401);
    const id=str(params.id,120),status=str(((body??{}) as Record<string,unknown>).status,40);if(!['pending','processing','shipped','completed','cancelled'].includes(status))return error('Invalid order status.',400);
    const [order]=await db.get<OrderRecord>('orders',[id],{consistent:true});if(!order)return error('Order was not found.',404);const updated={...order,status,updatedAt:new Date().toISOString()};const [ok]=await db.update('orders',[{id,record:updated}]);return ok?json({order:updated}):error('Could not update order.',503);
  }]
});