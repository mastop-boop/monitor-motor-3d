#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <U8g2lib.h>
#include <esp_timer.h>
#include <esp_system.h>
constexpr int PIN_RGB = 48; // DevKitC-1 V1.0 (V1.1: GPIO38)
#include <math.h>
#include <Preferences.h>

const char* RED="NOMBRE_DE_TU_WIFI";
const char* CLAVE="CLAVE_DE_TU_WIFI";
const char* CANAL="uni-lab/e7b914ca52/adxl345";
constexpr float RANGO_A=50.0f, RESISTENCIA_OHM=119.0f;
constexpr int PASADAS=2;
const char* CANAL_OLED="uni-lab/e7b914ca52/adxl345/oled";
// Lotes de corriente RMS muestreada cada 2 ms (tópico propio, no altera el formato principal)
const char* CANAL_I="uni-lab/e7b914ca52/adxl345/corriente";
constexpr int LOTE_MAX=64;
struct Lote { uint32_t seq=0; uint64_t t0=0; int n=0; float v[LOTE_MAX]; };
Lote loteListo; volatile bool hayLote=false;
constexpr bool NTC_A_GND=true;
Preferences ajustes;
uint8_t pagina=0;
uint8_t fotograma[1024];
uint32_t versionOLED=0;
float referenciaAngulo[3];
float referenciaY=NAN, referenciaD=NAN;
float sumaReferencia=0;
int pendientes=0;
char modoCal=0;

U8G2_SH1106_128X64_NONAME_F_SW_I2C oled(U8G2_R0,11,10,U8X8_PIN_NONE);
WiFiClient red;
PubSubClient mqtt(red);
portMUX_TYPE lockDatos=portMUX_INITIALIZER_UNLOCKED;
char sesion[9], cliente[24];
struct Datos {
  float xyz[3]={NAN,NAN,NAN};
  float temp=NAN, actual=NAN, pico100=NAN, pico=NAN;
  float voltios=NAN, angulo[3]={NAN,NAN,NAN};
  int fase=0, estado=0; // fase: 1 estrella, 2 delta; estado según textosOLED
  uint32_t seq=0;
  uint64_t ms=0;
};
void evaluarMotor(Datos& m,float nivel);
void dibujarPagina(const Datos& m,uint8_t seleccion);
Datos datos;

uint8_t dir=0;
float base[3],energia[3],piso[3],umbral[3],bloque[3],curva[3];
int confirmaciones[3];
uint32_t ultimaMuestra=0;
int muestras=0;
bool activo[3];

bool leer(uint8_t d,uint8_t reg,uint8_t* b,uint8_t n){
  Wire.beginTransmission(d); Wire.write(reg);
  if(Wire.endTransmission(false)!=0 || Wire.requestFrom(d,n)!=n) return false;
  for(int i=0;i<n;i++) b[i]=Wire.read();
  return true;
}
bool escribir(uint8_t d,uint8_t reg,uint8_t v){
  Wire.beginTransmission(d); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission()==0;
}
void iniciarADXL(){
  const uint8_t direcciones[]={0x53,0x1D};
  for(uint8_t d:direcciones){
    uint8_t id=0;
    if(leer(d,0,&id,1) && id==0xE5 && escribir(d,0x2D,0) &&
       escribir(d,0x31,8) && escribir(d,0x2C,0x0B) && escribir(d,0x2D,8)){
      dir=d; muestras=0; ultimaMuestra=millis();
      for(int i=0;i<3;i++){
        energia[i]=bloque[i]=curva[i]=piso[i]=umbral[i]=0;
        activo[i]=false; confirmaciones[i]=0;
      }
      Serial.println("ADXL listo. Dejar en reposo 4 segundos.");
      return;
    }
  }
}
void tomarVibracion(){
  uint8_t estado,b[6];
  if(!leer(dir,0x30,&estado,1)){dir=0;return;}
  if(!(estado&0x80)){if(millis()-ultimaMuestra>500) dir=0; return;}
  if(!leer(dir,0x32,b,6)){dir=0;return;}
  ultimaMuestra=millis();
  for(int i=0;i<3;i++){
    int16_t raw=int16_t(uint16_t(b[2*i])|(uint16_t(b[2*i+1])<<8));
    float a=raw*3.9f;
    if(muestras==0) base[i]=a;
    float delta=a-base[i];
    base[i]+=0.008f*delta;
    energia[i]+=0.10f*(delta*delta-energia[i]);
    float nivel=sqrtf(fmaxf(energia[i],0));
    if(muestras<800){
      if(muestras>=100){
        piso[i]+=(nivel-piso[i])/(muestras-99);
        umbral[i]=fmaxf(umbral[i],nivel);
      }
    }else{
      float inicio=umbral[i]+0.8f;
      if(activo[i]){
        if(nivel<=(piso[i]+inicio)*0.5f){activo[i]=false;confirmaciones[i]=0;}
      }else if(nivel>inicio){
        if(++confirmaciones[i]>=3) activo[i]=true;
      }else confirmaciones[i]=0;
      if(activo[i]) bloque[i]=fmaxf(bloque[i],nivel-piso[i]);
    }
  }
  if(muestras<800) muestras++;
}
float temperatura(){
  uint32_t suma=0;
  for(int i=0;i<8;i++) suma+=analogReadMilliVolts(5);
  float v=suma/8.0f;
  if(v<=30 || v>=3050) return NAN;
  float r=NTC_A_GND?10000*v/(3300-v):10000*(3300-v)/v;
  return 1.0f/(1.0f/298.15f+logf(r/10000)/3950)-273.15f;
}
const char* textosOLED[]={"Calibrando", "En reposo", "Sin referencia",
  "Fase incierta", "Motor normal*", "Pos. desalineacion", "Tomando referencia",
  "Revisar corriente", "Sin ADXL345"};

void revisarBoton(uint32_t ahora){
  static bool anterior=HIGH, estable=HIGH;
  static uint32_t desde=0;
  bool nivel=digitalRead(13);
  if(nivel!=anterior){anterior=nivel; desde=ahora;}
  if(nivel==estable || ahora-desde<20) return;
  estable=nivel;
  if(nivel==LOW){
    portENTER_CRITICAL(&lockDatos);
    pagina=(pagina+1)%3;
    uint8_t nueva=pagina;
    portEXIT_CRITICAL(&lockDatos);
    Serial.println(nueva==0?"Boton: temperatura":nueva==1?"Boton: corriente":"Boton: vibracion");
  }
}

// Compara vibración con referencias tomadas en este motor, en su montaje real.
void evaluarMotor(Datos& m, float nivel){
  static int candidato=0, repeticiones=0, faseEstable=0, altas=0;
  static float filtrado=NAN;
  if(Serial.available()){
    char orden=toupper(Serial.read());
    if(orden=='E' || orden=='D'){
      modoCal=orden; pendientes=20; sumaReferencia=0;
      Serial.println("Referencia: mantener el motor estable durante 2 segundos.");
    }
  }
  m.fase=0;
  if(!dir || !isfinite(nivel) || !isfinite(m.actual) || m.actual<0.10f){
    m.estado=!dir?8:!isfinite(nivel)?0:!isfinite(m.actual)?7:1;
    pendientes=0; filtrado=NAN; faseEstable=candidato=repeticiones=altas=0;
    return;
  }
  filtrado=isfinite(filtrado)?filtrado+0.25f*(nivel-filtrado):nivel;
  if(pendientes>0){
    sumaReferencia+=nivel; m.estado=6;
    if(--pendientes==0){
      float ref=sumaReferencia/20;
      if(ref>=1){
        if(modoCal=='E') referenciaY=ref; else referenciaD=ref;
        ajustes.putFloat(modoCal=='E'?"estrella":"delta",ref);
        Serial.printf("Referencia %c guardada: %.1f mg\n",modoCal,ref);
      }else Serial.println("Referencia insuficiente; repetir con el motor en marcha.");
      candidato=repeticiones=faseEstable=altas=0;
    }
    return;
  }
  if(!isfinite(referenciaY) || !isfinite(referenciaD)){m.estado=2;return;}
  float mayor=fmaxf(referenciaY,referenciaD);
  float separacion=fabsf(referenciaY-referenciaD);
  bool exceso=filtrado>mayor+fmaxf(4.0f,0.6f*mayor);
  altas=exceso?min(altas+1,5):0;
  if(exceso){m.estado=altas==5?5:3; candidato=repeticiones=0; return;}
  float errorY=fabsf(filtrado-referenciaY), errorD=fabsf(filtrado-referenciaD);
  int proxima=errorY<errorD?1:2;
  float ref=proxima==1?referenciaY:referenciaD;
  if(separacion<fmaxf(2.0f,0.2f*mayor) ||
     fabsf(errorY-errorD)<0.2f*separacion ||
     fminf(errorY,errorD)>fmaxf(2.0f,0.45f*ref)) proxima=0;
  if(proxima!=candidato){candidato=proxima;repeticiones=0;}
  if(++repeticiones>=5){faseEstable=candidato;repeticiones=5;}
  m.fase=(proxima==faseEstable)?faseEstable:0;
  m.estado=m.fase?4:3;
}

void adquirir(void*){
  Datos m;
  Lote lote;
  uint32_t intento=millis()-1000,adc=millis()-5,ntc=millis()-250,envio=millis();
  float suma=0,maximo=NAN,sumaMv=0;
  uint32_t diagnostico=0;
  int validas=0, intentosADC=0;
  bool luz=false, hubo=false;
  uint32_t comienzo=0, ultimoMovimiento=0;
  int color=0;
  for(;;){
    uint32_t ahora=millis();
    revisarBoton(ahora);
    if(!dir && ahora-intento>=1000){intento=ahora; iniciarADXL();}
    if(dir) tomarVibracion();
    bool movimiento=dir && muestras==800 && (activo[0]||activo[1]||activo[2]);
    if(movimiento){
      if(!hubo){comienzo=ahora;color=(color+1)%3;}
      ultimoMovimiento=ahora; hubo=true;
    }
    if(!dir || ahora-ultimoMovimiento>=140) hubo=false;
    bool encender=hubo && (ahora-comienzo)%250<140;
    if(encender!=luz){
      luz=encender;
      rgbLedWrite(PIN_RGB,luz && color==0?40:0,luz && color==1?40:0,
                         luz && color==2?40:0);
    }
    if(ahora-adc>=2){                       // corriente cada 2 ms (500 muestras/s)
      adc=ahora; intentosADC++;
      float mv=analogReadMilliVolts(4), lazo=mv/RESISTENCIA_OHM, i=NAN;
      sumaMv+=mv;
      if(lazo>=3.6f && lazo<=21.0f){
        i=fmaxf(0,(lazo-4)/16)*(RANGO_A/PASADAS);
        suma+=i; validas++;
        maximo=fmaxf(maximo,i); m.pico=fmaxf(m.pico,i);
      }
      if(lote.n==0) lote.t0=esp_timer_get_time()/1000ULL;
      if(lote.n<LOTE_MAX) lote.v[lote.n++]=i;
    }
    if(ahora-ntc>=250){ntc=ahora; m.temp=temperatura();}
    if(ahora-envio>=100){
      envio=ahora; m.seq++; m.ms=esp_timer_get_time()/1000ULL;
      m.actual=(validas>0 && 4*validas>=3*intentosADC)?suma/validas:NAN; m.pico100=maximo;
      m.voltios=intentosADC?sumaMv/intentosADC/1000.0f:NAN;
      if(ahora-diagnostico>=1000){
        diagnostico=ahora;
        Serial.printf("GPIO4 %.0f mV | lazo %.2f mA | consumo %.2f A\n",
          m.voltios*1000,m.voltios*1000/RESISTENCIA_OHM,m.actual);
      }
      sumaMv=0; suma=0; validas=0; intentosADC=0; maximo=NAN;
      float norma2=0;
      for(int i=0;i<3;i++){
        curva[i]=bloque[i]>0?curva[i]+0.75f*(bloque[i]-curva[i]):curva[i]*0.35f;
        if(curva[i]<0.15f) curva[i]=0;
        m.xyz[i]=(dir && muestras==800)?curva[i]:NAN;
        norma2+=m.xyz[i]*m.xyz[i]; bloque[i]=0;
      }
      static bool anguloListo=false;
      if(!dir || muestras<800) anguloListo=false;
      float g=sqrtf(base[0]*base[0]+base[1]*base[1]+base[2]*base[2]);
      bool valida=dir && muestras==800 && g>850 && g<1150;
      for(int i=0;i<3;i++){
        m.angulo[i]=NAN;
        if(valida){
          float inclinacion=asinf(constrain(base[i]/g,-1.0f,1.0f))*RAD_TO_DEG;
          if(!anguloListo) referenciaAngulo[i]=inclinacion;
          m.angulo[i]=inclinacion-referenciaAngulo[i];
        }
      }
      if(valida) anguloListo=true;
      evaluarMotor(m,sqrtf(norma2));
      lote.seq=m.seq;
      portENTER_CRITICAL(&lockDatos);
      datos=m;
      loteListo=lote; hayLote=true;
      portEXIT_CRITICAL(&lockDatos);
      lote.n=0;
    }
    delay(1);
  }
}

void centrar(const char* texto,int y){
  oled.drawUTF8((128-(int)oled.getUTF8Width(texto))/2,y,texto);
}
void dibujarPagina(const Datos& m,uint8_t seleccion){
  char texto[42];
  oled.setFont(u8g2_font_5x8_tf);
  centrar(seleccion==0?"Temperatura del bobinado":
          seleccion==1?"Corriente en el motor":"Vibración en el motor",9);
  oled.drawHLine(6,13,116);
  if(seleccion<2){
    float v=seleccion==0?m.temp:m.actual;
    if(isfinite(v)) snprintf(texto,sizeof(texto),seleccion==0?"%.1f":"%.2f",v);
    else strcpy(texto,"--");
    oled.setFont(u8g2_font_logisoso24_tn);
    int w=oled.getStrWidth(texto),x=(128-w-22)/2;
    oled.drawStr(x,45,texto);
    oled.setFont(u8g2_font_helvB14_tr);
    if(seleccion==0) oled.drawCircle(x+w+5,30,2);
    oled.drawStr(x+w+(seleccion==0?10:4),45,seleccion==0?"C":"A");
    if(seleccion==1){
      oled.setFont(u8g2_font_5x8_tf);
      snprintf(texto,sizeof(texto),"%.2f mA  |  %.3f V",m.voltios*1000/RESISTENCIA_OHM,m.voltios);
      centrar(isfinite(m.voltios)?texto:"-- mA  |  -- V",61);
    }
    return;
  }
  for(int i=0;i<3;i++){
    int centro=22+i*42;
    char eje[]={char('X'+i),0};
    oled.drawStr(centro-3,23,eje);
    if(isfinite(m.angulo[i])) snprintf(texto,sizeof(texto),"%ld°",lroundf(m.angulo[i]));
    else strcpy(texto,"--");
    oled.setFont(u8g2_font_helvB10_tf);
    oled.drawUTF8(centro-oled.getUTF8Width(texto)/2,39,texto);
    oled.setFont(u8g2_font_5x8_tf);
  }
  // Nivel animado: proyección XY de la inclinación relativa.
  oled.drawHLine(34,46,60);
  if(isfinite(m.angulo[0]) && isfinite(m.angulo[1])){
    int x=64+lroundf(constrain(m.angulo[0],-28.0f,28.0f));
    int y=46-lroundf(constrain(m.angulo[1]/5,-3.0f,3.0f));
    oled.drawDisc(x,y,2);
  }
  oled.drawUTF8(1,62,textosOLED[m.estado]);
  if(m.fase==1) oled.drawStr(108,62,"Y*");
  if(m.fase==2){oled.drawTriangle(109,60,113,52,117,60);oled.drawStr(119,60,"*");}
}
void pantalla(void*){
  uint32_t inicio=millis();
  for(;;){
    portENTER_CRITICAL(&lockDatos);
    Datos m=datos;
    uint8_t seleccion=pagina;
    portEXIT_CRITICAL(&lockDatos);
    oled.clearBuffer();
    if(millis()-inicio<2000){
      oled.setFont(u8g2_font_helvB18_tr); centrar("UNSA",34);
      oled.setFont(u8g2_font_6x10_tf); centrar("Iniciando...",54);
    }else dibujarPagina(m,seleccion);
    oled.sendBuffer();
    portENTER_CRITICAL(&lockDatos);
    if(memcmp(fotograma,oled.getBufferPtr(),sizeof(fotograma)) || !versionOLED){
      memcpy(fotograma,oled.getBufferPtr(),sizeof(fotograma));versionOLED++;
    }
    portEXIT_CRITICAL(&lockDatos);
    delay(75);
  }
}

void setup(){
  Serial.begin(115200);
  pinMode(13,INPUT_PULLUP);
  Wire.begin(6,7,400000); Wire.setTimeOut(10);
  analogSetPinAttenuation(4,ADC_11db);analogSetPinAttenuation(5,ADC_11db);
  ajustes.begin("motor-oled",false);
  referenciaY=ajustes.getFloat("estrella",NAN);
  referenciaD=ajustes.getFloat("delta",NAN);
  oled.begin();
  rgbLedWrite(PIN_RGB,0,0,0);
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(RED,CLAVE);
  snprintf(sesion,sizeof(sesion),"%08lx",(unsigned long)esp_random());
  snprintf(cliente,sizeof(cliente),"motor-%s",sesion);
  mqtt.setBufferSize(1280);
  mqtt.setServer("test.mosquitto.org",1883);mqtt.setSocketTimeout(3);
  xTaskCreate(adquirir,"sensores",6144,nullptr,3,nullptr);
  xTaskCreate(pantalla,"OLED",6144,nullptr,1,nullptr);
}
void loop(){
  static uint32_t intento=millis()-5000,enviado=0,versionEnviada=0,ultimoOLED=0;
  static uint8_t imagen[1024];
  if(WiFi.status()==WL_CONNECTED){
    if(!mqtt.connected() && millis()-intento>=5000){
      intento=millis();
      if(mqtt.connect(cliente)){ red.setNoDelay(true); versionEnviada=0; }   // sin Nagle: menor latencia
    }
    if(mqtt.connected()){
      mqtt.loop();
      portENTER_CRITICAL(&lockDatos);
      Datos m=datos;
      uint32_t version=versionOLED;
      bool enviarImagen=version && (version!=versionEnviada || millis()-ultimoOLED>=1000);
      if(enviarImagen) memcpy(imagen,fotograma,sizeof(imagen));
      portEXIT_CRITICAL(&lockDatos);
      if(m.seq!=enviado){
        char msg[250];
        snprintf(msg,sizeof(msg),"%s,%lu,%llu,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.2f,A,%.3f,%.2f,%.2f,%.2f,%d,%d",
          sesion,(unsigned long)m.seq,(unsigned long long)m.ms,
          m.xyz[0],m.xyz[1],m.xyz[2],m.actual,m.pico100,m.pico,m.temp,m.voltios,m.angulo[0],m.angulo[1],m.angulo[2],m.fase,m.estado);
        if(mqtt.publish(CANAL,msg,false)) enviado=m.seq;
      }
      // lote de corriente: sesion,seq,t0_ms,dt_ms,i1,i2,...  (A; "nan" si el lazo está fuera de 3,6-21 mA)
      portENTER_CRITICAL(&lockDatos);
      bool tengoLote=hayLote; static Lote L; if(tengoLote){ L=loteListo; hayLote=false; }
      portEXIT_CRITICAL(&lockDatos);
      if(tengoLote && L.n>0){
        static char li[700];
        int p=snprintf(li,sizeof(li),"%s,%lu,%llu,2",sesion,(unsigned long)L.seq,(unsigned long long)L.t0);
        for(int k=0;k<L.n && p<(int)sizeof(li)-10;k++)
          p+=isfinite(L.v[k])?snprintf(li+p,sizeof(li)-p,",%.2f",L.v[k]):snprintf(li+p,sizeof(li)-p,",nan");
        mqtt.publish(CANAL_I,li,false);
      }
      if(enviarImagen && mqtt.publish(CANAL_OLED,imagen,sizeof(imagen),false)){
        versionEnviada=version; ultimoOLED=millis();
      }
    }
  }
  delay(2);
}
