import fs from "fs";
import path from "path";
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
const envFile = path.resolve('.env.local');
const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const env = Object.fromEntries(content.split(/\r?\n/).map(line => { const l=line.trim(); if (!l || l.startsWith('#')) return null; const i=l.indexOf('='); if (i<0) return null; return [l.slice(0,i), l.slice(i+1)]; }).filter(Boolean));
function tryKey(name, value) {
  if (!value) return null;
  const environment = value.startsWith('pdl_sdbx_') ? Environment.sandbox : Environment.production;
  return { name, prefix: value.slice(0, 20), environment, value };
}
const keys = [tryKey('PADDLE_API_KEY', env.PADDLE_API_KEY)].filter(Boolean);
for (const k of keys) {
  console.log(`TRY ${k.name} ${k.prefix} env=${k.environment===Environment.production?'production':'sandbox'}`);
  const paddle = new Paddle(k.value, { environment: k.environment, logLevel: 0 });
  try {
    const products = await paddle.products.list({ include: ['prices'], per_page: 20, status: ['active'] });
    console.log(`SUCCESS ${k.name} products ${products.data.length}`);
    console.log(JSON.stringify(products.data.slice(0, 10).map(p => ({ id: p.id, name: p.name, status: p.status, prices: p.prices?.map(pr => ({ id: pr.id, currency: pr.unit_price?.currency_code, amount: pr.unit_price?.amount, billing_cycle: pr.billing_cycle, status: pr.status })) })), null, 2));
  } catch (err) {
    console.error(`ERROR ${k.name}`, err instanceof Error ? err.message : err);
  }
}