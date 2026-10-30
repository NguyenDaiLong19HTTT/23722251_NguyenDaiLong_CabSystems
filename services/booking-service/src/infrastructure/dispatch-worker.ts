import {BookingCommands} from '../application/booking-commands.js';
import {markWorkerHealthy} from '@cab/grpc-transport';

export class DispatchWorker {
  private timer?:ReturnType<typeof setTimeout>;
  private stopped=false;
  constructor(private readonly commands:BookingCommands) {}
  start():void {this.stopped=false;this.schedule(0);}
  private schedule(delay:number):void {
    if(!this.stopped) this.timer=setTimeout(()=>void this.tick(),delay);
  }
  private async tick():Promise<void> {
    try {await this.commands.tickDispatch();markWorkerHealthy('booking','booking-dispatch');
      this.schedule(1000);}
    catch {this.schedule(2000);}
  }
  async close():Promise<void> {this.stopped=true;if(this.timer) clearTimeout(this.timer);}
}
