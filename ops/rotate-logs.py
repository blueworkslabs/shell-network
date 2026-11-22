#!/usr/bin/env python3
"""Bounded local diagnostic log retention. Copy/truncate preserves open descriptors."""
from pathlib import Path
import os,fcntl,time,json
H=Path.home();STATE=H/'.local/state/t3-bridge';LIMIT=8*1024*1024;BUDGET=128*1024*1024;KEEP=3;AGE=7*86400

def regular(p):
 try:
  s=p.lstat();return p.is_file() and not p.is_symlink() and s.st_uid==os.getuid() and s.st_nlink==1
 except FileNotFoundError:return False

def retain(sources):
 limit,budget,keep=LIMIT,BUDGET,KEEP
 sources=[p for p in sources if regular(p)];rotated=0;pruned=0
 for p in sources:
  if p.stat().st_size<=limit:continue
  for n in range(keep,0,-1):
   q=Path(str(p)+'.'+str(n))
   if q.exists():
    if not regular(q):raise RuntimeError('Unsafe rotation path')
    if n==keep:q.unlink()
    else:q.replace(Path(str(p)+'.'+str(n+1)))
  fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW)
  with os.fdopen(fd,'r+b') as f:
   size=os.fstat(f.fileno()).st_size;f.seek(max(0,size-limit));tail=f.read()
   if size>limit:tail=tail.partition(b'\n')[2]
   q=Path(str(p)+'.1');out=os.open(q,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(out,'wb') as dest:dest.write(tail)
   f.truncate(0)
  rotated+=1
 archives=[Path(str(p)+'.'+str(n)) for p in sources for n in range(1,keep+1)]
 for p in archives:
  if regular(p) and time.time()-p.stat().st_mtime>AGE:p.unlink();pruned+=1
 archives=[p for p in archives if regular(p)]
 total=sum(p.stat().st_size for p in sources+archives)
 for p in sorted(archives,key=lambda x:x.stat().st_mtime):
  if total<=budget:break
  total-=p.stat().st_size;p.unlink();pruned+=1
 # Old provider diagnostic files also count against the shared budget. Preserve their inode for open writers.
 for p in sorted(sources,key=lambda x:x.stat().st_mtime):
  if total<=budget:break
  fd=os.open(p,os.O_WRONLY|os.O_NOFOLLOW)
  try:total-=os.fstat(fd).st_size;os.ftruncate(fd,0)
  finally:os.close(fd)
  pruned+=1
 return {'sources':len(sources),'rotated':rotated,'pruned':pruned,'bytes_after':sum(p.stat().st_size for p in sources+archives if regular(p)),'budget_bytes':budget}

if __name__=='__main__':
 STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
 with open(STATE/'log-retention.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  sources=list(STATE.glob('*.jsonl'))+list(STATE.glob('*.log'))+[H/'.local/state/t3-staging/server.log']
  sources+=list((H/'.local/state/t3-staging/data/userdata/logs/provider').glob('*.log'))
  print(json.dumps(retain(sources)))
