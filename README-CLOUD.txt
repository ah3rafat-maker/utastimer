نسخة v28 - مزامنة سحابية بين كل الأجهزة والمتصفحات

هذه النسخة تعمل محليًا كالسابق إذا كان firebase-config.js فارغًا.
لجعل التعديلات تظهر على Firefox وSafari وChrome وكل الأجهزة، يجب إعداد Firebase Realtime Database.

الخطوات المختصرة:
1) ادخل إلى https://console.firebase.google.com وأنشئ مشروعًا جديدًا.
2) من Build > Realtime Database أنشئ قاعدة بيانات.
3) اختر وضع test mode مؤقتًا للتجربة.
4) من Project settings > General > Your apps أضف Web App.
5) انسخ firebaseConfig.
6) افتح ملف firebase-config.js والصق الإعدادات بدل:
   window.FIREBASE_CONFIG = null;
7) ارفع الملفات إلى GitHub، وسيعيد Vercel النشر تلقائيًا.

مهم:
- بعد إعداد Firebase، كلمة المرور وملف Excel والتعديلات والإعدادات تصبح مشتركة بين كل الأجهزة والمتصفحات.
- استخدم test mode للتجربة فقط. بعد التأكد، يجب ضبط قواعد الحماية في Firebase.
