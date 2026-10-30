import {Injectable} from '@nestjs/common';

// One demo Gateway instance. Express does not trust X-Forwarded-For, so the
// bucket key is the actual peer address rather than a client-supplied header.
@Injectable()
export class BookingCreateLimiter {
  private readonly buckets=new Map<string,{count:number;until:number}>();
  private lastSweep=0;
  take(peer:string,now=Date.now()):number|undefined {
    if(now-this.lastSweep>=60_000) {
      for(const [key,value] of this.buckets)
        if(value.until<=now) this.buckets.delete(key);
      this.lastSweep=now;
    }
    const current=this.buckets.get(peer);
    if(!current||current.until<=now) {
      // Refuse excess distinct peers if memory cannot be bounded.
      if(this.buckets.size>=10_000) return 60;
      this.buckets.set(peer,{count:1,until:now+60_000});
      return;
    }
    if(current.count>=30) return Math.max(1,Math.ceil((current.until-now)/1000));
    current.count++;
    return;
  }
}
