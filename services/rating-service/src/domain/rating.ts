export type RatingInput={score:number;comment:string|null};
export function normalizeRating(score:unknown,comment:unknown):RatingInput {
  if(typeof score!=='number'||!Number.isInteger(score)||score<1||score>5)
    throw new Error('VALIDATION_ERROR');
  if(comment!==undefined&&(typeof comment!=='string'||comment.length>1000))
    throw new Error('VALIDATION_ERROR');
  return {score,comment:typeof comment==='string'?comment.trim()||null:null};
}
