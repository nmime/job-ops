#!/usr/bin/env python3
import os,re,ssl,json,time,imaplib,email,sqlite3,uuid,hashlib,socket
from email.header import decode_header
from email.utils import parsedate_to_datetime,parseaddr
from pathlib import Path
ROOT=Path('/opt/job-ops'); OUT=Path(os.environ.get('DO_ALL_DIR') or (ROOT/'backups/latest_do_all_dir.txt').read_text().strip()); OUT.mkdir(parents=True,exist_ok=True)
DB=ROOT/'data/jobs.db'; START='01-May-2026'; socket.setdefaulttimeout(20)
summary={'mcp_gmail_connected':False,'local_imap_attempted':False,'local_imap_ok':False,'messages_scanned':0,'messages_analyzed':0,'inserted':0,'matched':0,'confirmations':0,'rejections':0,'alternates':0,'bounces':0,'manual_followup':0,'retries_sent':0,'errors':[]}
red=lambda s: re.sub(r'[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})','***@\\1',str(s or ''),flags=re.I)
def envload(p):
 d={}
 for line in Path(p).read_text(errors='ignore').splitlines():
  if line and not line.lstrip().startswith('#') and '=' in line:
   k,v=line.split('=',1); d[k.strip()]=v.strip().strip('"').strip("'")
 return d
def dec(x):
 out=''
 for b,enc in decode_header(x or ''):
  out += b.decode(enc or 'utf-8','ignore') if isinstance(b,bytes) else b
 return out
def body(msg):
 parts=[]
 for part in (msg.walk() if msg.is_multipart() else [msg]):
  if part.get_content_type() in ('text/plain','text/html') and 'attachment' not in str(part.get('Content-Disposition') or '').lower():
   try: parts.append(part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8','ignore'))
   except Exception: pass
 return re.sub(r'\s+',' ',re.sub('<[^>]+>',' ','\n'.join(parts))).strip()[:5000]
def classify(subj,txt,frm):
 s=(subj+' '+txt).lower(); label='other'; typ='other'; follow=False
 if re.search(r'undeliver|delivery status|mail delivery|returned mail|bounce|address not found|couldn.t be delivered',s): label='bounce'; typ='update'
 elif re.search(r'interview|schedule|next step|assessment|coding challenge|calendar|availability|call with|meet with',s): label='interview'; typ='interview'; follow=True
 elif re.search(r'offer|congratulations',s): label='offer'; typ='offer'; follow=True
 elif re.search(r'unfortunately|not moving forward|decided not to proceed|other candidates|reject|decline',s): label='rejection'; typ='rejection'
 elif re.search(r'thank you for applying|application received|we received|confirmation|successfully submitted|your application',s): label='confirmation'; typ='update'
 elif re.search(r'already applied|duplicate application|previously submitted',s): label='already_applied'; typ='update'
 if re.search(r'apply (?:at|to)|send .*application|alternate|instead|forward.*resume',s): follow=True
 bad=re.compile(r'no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster',re.I)
 alts=sorted(set(e.lower() for e in re.findall(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',subj+' '+txt,flags=re.I) if not bad.search(e) and e.lower()!=parseaddr(frm)[1].lower()))[:5]
 return label,typ,follow,alts
try:
 env=envload(ROOT/'.env'); user=env.get('GMAIL_USER') or env.get('IMAP_USER') or env.get('AUTO_APPLY_SMTP_USER') or env.get('AUTO_APPLY_EMAIL_FROM'); pwd=env.get('GMAIL_APP_PASSWORD') or env.get('IMAP_PASS') or env.get('AUTO_APPLY_SMTP_PASS'); smtp=env.get('AUTO_APPLY_SMTP_HOST',''); host=env.get('IMAP_HOST') or ('imap.gmail.com' if 'gmail' in smtp.lower() or (user and 'gmail.com' in user.lower()) else re.sub(r'^smtp','imap',smtp) if smtp else '')
 if not (user and pwd and host): raise RuntimeError('no local IMAP/Gmail credentials found; connected Gmail MCP not available')
 summary['local_imap_attempted']=True; im=imaplib.IMAP4_SSL(host,int(env.get('IMAP_PORT') or 993),ssl_context=ssl.create_default_context()); im.login(user,pwd); summary['local_imap_ok']=True
 conn=sqlite3.connect(DB, timeout=30); conn.execute('PRAGMA busy_timeout=30000'); conn.row_factory=sqlite3.Row
 jobs=[dict(r) for r in conn.execute("select id,title,employer,application_link,job_url,employer_url from jobs where status in ('applied','ready','skipped')")]
 def match_job(subj,txt,frm):
  hay=(subj+' '+txt+' '+frm).lower(); best=None; score=0
  for j in jobs:
   sc=0; emp=(j.get('employer') or '').lower().split('|')[0].strip(); title=(j.get('title') or '').lower()
   if emp and emp in hay: sc+=3
   for tok in re.findall(r'[a-z0-9]{4,}',title)[:8]:
    if tok in hay: sc+=1
   if sc>score: score=sc; best=j
  return best if score>=3 else None
 run_id=str(uuid.uuid4()); now=int(time.time()); dt=time.strftime('%Y-%m-%d %H:%M:%S')
 conn.execute('insert into post_application_sync_runs(id,provider,account_key,status,started_at,created_at,updated_at) values(?,?,?,?,?,?,?)',(run_id,'imap','default','running',now,dt,dt))
 for mailbox in ['INBOX','[Gmail]/Sent Mail','Sent']:
  try:
   typ,_=im.select('"%s"'%mailbox if ' ' in mailbox else mailbox, readonly=True)
   if typ!='OK': continue
   typ,data=im.search(None,'SINCE',START); ids=(data[0] or b'').split()[-80:]
   for mid in ids:
    typ,msgdata=im.fetch(mid,'(RFC822)')
    if typ!='OK' or not msgdata: continue
    raw=msgdata[0][1]; msg=email.message_from_bytes(raw); subj=dec(msg.get('Subject','')); frm=dec(msg.get('From','')); txt=body(msg); summary['messages_scanned']+=1
    if not re.search(r'job|career|apply|application|interview|recruit|hiring|resume|cv|talent|position|engineer',subj+' '+txt,re.I): continue
    label,typ2,follow,alts=classify(subj,txt,frm); summary['messages_analyzed']+=1
    for k,l in [('confirmations','confirmation'),('rejections','rejection'),('bounces','bounce')]:
     if label==l: summary[k]+=1
    summary['alternates']+=len(alts); summary['manual_followup']+=1 if follow else 0
    job=match_job(subj,txt,frm); jid=job['id'] if job else None; summary['matched']+=1 if jid else 0
    ext=msg.get('Message-ID') or hashlib.sha256(raw).hexdigest(); sender=parseaddr(frm)[1]; dom=sender.split('@')[-1].lower() if '@' in sender else ''; payload=json.dumps({'label':label,'alternate_addresses_redacted':[red(a) for a in alts],'mailbox':mailbox})
    try:
     conn.execute('''insert or ignore into post_application_messages(id,provider,account_key,sync_run_id,external_message_id,external_thread_id,from_address,from_domain,sender_name,subject,received_at,snippet,classification_label,classification_confidence,classification_payload,relevance_decision,message_type,processing_status,matched_job_id,decided_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',(str(uuid.uuid4()),'imap','default',run_id,ext,msg.get('In-Reply-To') or ext,sender,dom,parseaddr(frm)[0],subj,int(parsedate_to_datetime(msg.get('Date')).timestamp()) if msg.get('Date') else now,red(txt[:500]),label,0.75,payload,'relevant',typ2,'auto_linked' if jid else 'pending_user',jid,now,dt,dt))
     summary['inserted']+=1 if conn.total_changes else 0
    except Exception as e: summary['errors'].append('insert:'+str(e)[:120])
    if jid:
     try: conn.execute('insert into stage_events(id,application_id,title,to_stage,occurred_at,metadata,outcome) values(?,?,?,?,?,?,?)',(str(uuid.uuid4()),jid,'Incoming application email analyzed','no_change',now,json.dumps({'label':label,'source':'do_all_email_sync','snippet':red(txt[:250])}),label))
     except Exception as e: summary['errors'].append('stage:'+str(e)[:120])
   conn.commit()
  except Exception as e: summary['errors'].append('mailbox '+mailbox+': '+str(e)[:160])
 conn.execute('update post_application_sync_runs set status=?,completed_at=?,messages_discovered=?,messages_relevant=?,messages_classified=?,messages_matched=?,updated_at=? where id=?',('completed',int(time.time()),summary['messages_scanned'],summary['messages_analyzed'],summary['messages_analyzed'],summary['matched'],time.strftime('%Y-%m-%d %H:%M:%S'),run_id)); conn.commit(); conn.close(); im.logout()
except Exception as e:
 summary['errors'].append(str(e)[:300])
(OUT/'incoming_email_processing_summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps({k:v for k,v in summary.items() if k!='errors'},indent=2))
if summary['errors']: print('ERRORS',json.dumps(summary['errors'][-5:]))
