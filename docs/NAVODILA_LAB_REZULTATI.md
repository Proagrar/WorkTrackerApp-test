# Vnos laboratorijskih rezultatov (Analize tal)

Kratek opis, kako laboratorijski rezultati pridejo v aplikacijo — niso vneseni ročno, ampak **uvoženi iz Excel datotek**, ki jih pošlje laboratorij.

## Kje v aplikaciji

**Gnojilni načrt** (admin-only zavihek) → **Analize tal** → gumb **⬆ Uvoz Excel**.

## Korak 1 — izbira datotek

Na voljo so tri poti:
- izbira posameznih `.xlsx` datotek,
- izbira cele mape (vse `.xlsx` v njej),
- povleci-in-spusti (drag & drop) na območje za uvoz.

Polje **"Filter imena"** je privzeto nastavljeno na `proagrar <trenutno leto>` — iz skupne mape z rezultati (kjer so tudi datoteke drugih strank/laboratorijev/let) izbere samo tiste, ki v imenu vsebujejo vse besede iz filtra (vrstni red ni pomemben, velikost črk ni pomembna). Po potrebi filter spremeniš, če je treba uvoziti kaj drugega (npr. starejše leto).

**Ime datoteke mora vsebovati datum v obliki `d.m.yyyy`** (npr. `Proagrar d.o.o._21.10.2026.xlsx`) — to je **datum analize**, ker ga Excel list sam po sebi ne vsebuje. Brez prepoznanega datuma se uvozi, le brez datuma analize.

## Korak 2 — samodejno branje in ujemanje (predogled)

Za vsako izbrano datoteko aplikacija:

1. **Prebere glavo tabele** (v prvih 10 vrsticah) — prepozna dve varianti stolpcev, kot ju laboratorij uporablja:
   - madžarska: `MINTASZAM` (lab. koda) / `MINTAAZONO` (št. vzorca),
   - angleška: `SamplePartnerCode` / `ClientSampleCode`.
   
   Če nobenega od teh stolpcev ne najde, datoteka **ni** izvoz laboratorija in se preskoči ("Ni stolpca MINTAAZONO / ClientSampleCode").

2. **Prepozna vrednostne stolpce** (ne glede na velike/male črke, šumnike, ločila): pH (KCl), KA, CaCO3, Humus %, NO3+NO2-N, P2O5, K2O, Mg, Na, Zn, Cu, Mn, Skupne soli %, SO4-S, Fe. Stolpci, ki jih ne prepozna (npr. "B" — bor), ostanejo shranjeni kot surovo besedilo, le ne gredo v svoj lastni izračunski stolpec.

3. **Pretvori vrednosti v števila** — vejica postane pika, `<25`/`>60` postane `25`/`60` (enako kot stari Excel izračun), vse ostalo (`#VALUE!`, opombe, `BB`...) ostane `null`, a **original tekst se vedno ohrani** (za primer napake pri branju).

4. **Preskoči že uvožene podatke**:
   - ista datoteka (po vsebini, ne imenu) že uvožena → cela datoteka preskočena,
   - ista lab. koda že obstaja v bazi (ponovno poslan rezultat v drugi datoteki, ali podvojena vrstica znotraj iste pošiljke) → ta vrstica preskočena.

5. **Samodejno poveže vsak rezultat z vzorcem na delovnem nalogu** — po **številki vzorca** (`sample_no`, enaka tista, ki jo vidite kot "Št. segmenta" pri GERK-u na nalogu):
   - natanko en ujemajoč vzorec → samodejno povezano,
   - več vzorcev z isto številko (različni nalogi) → ni samodejno povezano, označeno "Več vzorcev — poveži ročno",
   - noben ujemajoč vzorec → ni povezano (npr. star vzorec iz pred-aplikacijske dobe, ali napačno prepisana številka).

Preden se karkoli zapiše v bazo, se prikaže **predogled** — po datoteki: koliko vrstic, koliko povezanih/nepovezanih/z več zadetki/brez lab. kode/že obstoječih, in primeri vrednosti, ki jih ni bilo mogoče prebrati. Šele na **"Uvozi N rezultatov"** se podatki dejansko zapišejo (`lab_import_file` + `lab_soil_result`).

## Korak 3 — seznam in ročno povezovanje

Nazaj v **Analize tal**, preklop **"Prikaz"**:
- **Povezani z nalogi** (privzeto) — samo rezultati, ki so povezani z vzorcem na delovnem nalogu; to je uporaben seznam za pripravo gnojilnega načrta.
- **Nepovezani** — vse ostalo (predvsem stare številke vzorcev iz pred-aplikacijske dobe, ali tipkarske napake). Vsaka vrstica ima gumb **"Poveži"**, ki pokaže vse vzorce z isto številko (nalog, stranka, GERK) za ročno izbiro.

Rezultat brez lab. kode (laboratorij ni poslal kode — gre za združen ali naknadno dopolnjen vzorec) se obravnava enako kot vsak drug; v stolpcu "Lab. koda" je prazen ("—"), v UI ni posebej označen (od v4.69 naprej, prej je imel značko "brez kode" — odstranjena, ker je zavajala uporabnike, da je potrebna neka akcija).

## Od rezultata do gnojilnega načrta

V vrstici povezanega rezultata je stolpec **"Gnojilni načrt"**: če načrt za to GERK-linijo še ne obstaja, gumb **"+ Ustvari"** odpre čarovnika za nov načrt (stranka in GERK sta že izbrana); če že obstaja, gumb **"Odpri"** vodi nanj (značka Osnutek/Potrjeno).

## Alternativa: direktni uvoz iz mape (brez brskalnika)

Če imate Excel datoteke že zbrane v eni mapi na računalniku in jih želite uvoziti **naenkrat, brez odpiranja aplikacije**, je na voljo skripta `scripts/uvoz_lab_rezultatov/import.js`. Naredi **popolnoma isto** kot "Uvoz Excel" v aplikaciji (ista pravila prepoznavanja glave, iste pretvorbe vrednosti, isto preskakovanje že uvoženih datotek/kod, isto ujemanje po številki vzorca) — razlika je le, da teče iz ukazne vrstice namesto v brskalniku.

### Priprava (samo prvič)

Potreben je [Node.js](https://nodejs.org) (ista različica, ki jo Claude Code že uporablja za `node --check`).

```
cd scripts\uvoz_lab_rezultatov
npm install
```

To enkratno namesti dve knjižnici (`xlsx` za branje Excela, `@supabase/supabase-js` za povezavo z bazo) v to podmapo — ne vpliva na nič drugega v projektu.

### Prijava

Skripta piše v bazo kot prijavljen administrator (enako kot aplikacija sama — tabeli `lab_soil_result`/`lab_import_file` dovolita pisanje samo adminu). Geslo se nikamor ne shrani, poda se vsakič znova prek dveh spremenljivk okolja.

PowerShell:
```powershell
$env:SUPABASE_EMAIL = "admin@proagrar.si"
$env:SUPABASE_PASSWORD = "..."
```

### Uporaba

Najprej **vedno suhi tek** (brez `--potrdi`) — izpiše natanko to, kar bi uvozil, ne da bi karkoli zapisal:

```powershell
node scripts\uvoz_lab_rezultatov\import.js "C:\pot\do\mape\z\rezultati"
```

Izpiše po datoteki: koliko vrstic, koliko jih je samodejno povezanih z vzorcem/nepovezanih/z več zadetki/brez lab. kode/že obstoječih, in opozori na vrednosti, ki jih ni bilo mogoče prebrati. Preveri ta izpis, preden nadaljuješ.

Ko je izpis v redu, poženi **še enkrat z `--potrdi`** — šele to dejansko zapiše v `lab_import_file`/`lab_soil_result`:

```powershell
node scripts\uvoz_lab_rezultatov\import.js "C:\pot\do\mape\z\rezultati" --potrdi
```

Neobvezno — filter imena datotek (enako kot polje "Filter imena" v aplikaciji), če mapa vsebuje tudi datoteke, ki jih ne želite uvoziti:

```powershell
node scripts\uvoz_lab_rezultatov\import.js "C:\pot\do\mape" --filter "proagrar 2026" --potrdi
```

Rezultati, uvoženi tako, se takoj pojavijo v aplikaciji (Analize tal) — ni razlike med tem in uvozom prek brskalnika; oboje piše v isti dve tabeli.

## Povzetek poti podatkov

```
Excel od laboratorija
  → uvoz (Analize tal → Uvoz Excel)
  → lab_import_file (ena vrstica na datoteko) + lab_soil_result (ena vrstica na vzorec)
  → samodejna/ročna povezava na delovni nalog preko sample_no → delovni_nalogi_vzorci.id (lab_soil_result.vzorec_id)
  → gnojilni načrt (fert_plan)
```

Vse to je v kodi implementirano v `fertilization.js` (uvoz: `handleFiles`/`parseWorkbook`/`confirmImport`; seznam in ročno povezovanje: `loadLabResults`/`openLinkPicker`/`linkLabResult`).
