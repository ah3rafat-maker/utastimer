نسخة v30 - مزامنة سحابية عبر Firebase Realtime Database

مهم جدًا:
لا يمكن أن تظهر التعديلات وكلمة المرور على كل المتصفحات والأجهزة إذا كان firebase-config.js فارغًا.
بدون Firebase سيعمل الموقع محليًا فقط، أي أن كل متصفح له بياناته الخاصة.

خطوات الإعداد:
1) افتح https://console.firebase.google.com
2) أنشئ مشروعًا جديدًا.
3) من Build > Realtime Database أنشئ قاعدة بيانات.
4) أثناء التجربة فقط اجعل Rules كالتالي:
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
5) من Project settings > General > Your apps أضف Web app.
6) انسخ firebaseConfig وضعه في firebase-config.js بدل null.
7) ارفع الملفات إلى GitHub/Vercel من جديد.
8) افتح صفحة الإعدادات. يجب أن تظهر عبارة: متصل بالمزامنة السحابية.

إذا ظهرت عبارة: Firebase غير مفعّل، فلن تنتقل البيانات بين Safari وFirefox وChrome.
