//! Shared validation for both streaming and non-streaming assistant requests.
use serde_json::{json,Value};
pub fn image_content(text: &str, images: &[String]) -> Result<Value,String> {
    if images.is_empty() { return Ok(json!(text)); }
    if images.len()>4 || images.iter().map(String::len).sum::<usize>()>2_500_000 { return Err("图片数量或总大小超出限制".into()); }
    let mut content=vec![json!({"type":"text","text":text})];
    for image in images {
        let (head,data)=image.split_once(',').ok_or("图片格式无效")?;
        if !matches!(head,"data:image/png;base64"|"data:image/jpeg;base64"|"data:image/webp;base64") || image.len()>1_050_000
            || data.is_empty() || data.bytes().any(|b|!b.is_ascii_alphanumeric()&&!b"+/=".contains(&b)) { return Err("仅支持有大小限制的 PNG/JPEG/WebP 图片".into()); }
        content.push(json!({"type":"image_url","image_url":{"url":image}}));
    }
    Ok(json!(content))
}
pub fn apply_reasoning(body:&mut Value, protocol:Option<&str>, effort:Option<&str>, base:&str)->Result<(),String>{
    let effort=effort.unwrap_or("auto");
    if !matches!(effort,"auto"|"none"|"low"|"medium"|"high"|"max") {return Err("思考强度无效".into());}
    let protocol=protocol.unwrap_or("auto");
    if !matches!(protocol,"auto"|"standard"|"deepseek") {return Err("思考参数协议无效".into());}
    if effort=="auto" {return Ok(());}
    let deepseek=protocol=="deepseek" || (protocol=="auto" && url::Url::parse(base).ok().and_then(|u|u.host_str().map(str::to_owned)).as_deref()==Some("api.deepseek.com"));
    if deepseek {
        if !matches!(effort,"none"|"low"|"high"|"max") {return Err("DeepSeek 此接口使用关闭/低/高/最高强度；请更换档位或选择模型默认".into());}
        body["thinking"]=json!({"type":if effort=="none"{"disabled"}else{"enabled"}});
        if effort!="none" {body["reasoning_effort"]=json!(effort);}
    } else {body["reasoning_effort"]=json!(effort);}
    if effort!="none" {body.as_object_mut().unwrap().remove("temperature");}
    Ok(())
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn actual_request_shapes(){
        let mut b=json!({"temperature":0.2});apply_reasoning(&mut b,None,Some("high"),"https://example.test/v1").unwrap();assert_eq!(b["reasoning_effort"],"high");assert!(b.get("temperature").is_none());
        let mut b=json!({});apply_reasoning(&mut b,None,Some("high"),"https://api.deepseek.com/v1").unwrap();assert_eq!(b["thinking"]["type"],"enabled");
        assert!(apply_reasoning(&mut b,Some("deepseek"),Some("medium"),"").is_err());
        let mut b=json!({});apply_reasoning(&mut b,None,None,"").unwrap();assert_eq!(b,json!({}));
        assert!(image_content("hi",&["https://example.test/private".into()]).is_err());
        assert_eq!(image_content("hi",&["data:image/png;base64,iVBORw==".into()]).unwrap()[1]["type"],"image_url");
    }
}
