export const MOTORBIKE='MOTORBIKE';
export const PRICE_PER_KM_VND=5300n;
export type Route={routeId:string;version:bigint;pickupLatitude:number;
  pickupLongitude:number;destinationLatitude:number;destinationLongitude:number;
  distanceMeters:bigint};

// Integer arithmetic gives ROUND_HALF_UP to one VND; no intermediate km rounding.
export function fareForPriceVnd(distanceMeters:bigint,pricePerKm:string):bigint {
  if (distanceMeters<=0n) throw new Error('Invalid route distance');
  const match=/^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(pricePerKm);
  if (!match) throw new Error('Invalid price precision');
  const micro=BigInt(match[1]!)*1000000n+
    BigInt((match[2]??'').padEnd(6,'0'));
  return (distanceMeters*micro+500000000n)/1000000000n;
}
export const fareVnd=(distanceMeters:bigint)=>
  fareForPriceVnd(distanceMeters,String(PRICE_PER_KM_VND));
export function matchesRoute(route:Route,pickup:{latitude:number;longitude:number},
  destination:{latitude:number;longitude:number}):boolean {
  return route.pickupLatitude===pickup.latitude&&route.pickupLongitude===pickup.longitude&&
    route.destinationLatitude===destination.latitude&&
    route.destinationLongitude===destination.longitude;
}
