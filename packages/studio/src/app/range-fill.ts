import { AfterViewInit, Directive, DoCheck, ElementRef, HostListener, inject } from '@angular/core'

/**
 * Remplit la piste d'un `<input type=range>` jusqu'au curseur.
 *
 * Chromium ne sait pas peindre la portion parcourue : la piste est d'une seule
 * couleur des deux côtés. On expose donc la position en pourcentage dans une
 * variable CSS que le dégradé de la piste consomme (voir styles.css).
 * Mise à jour au pointeur ET à chaque cycle de rendu, pour suivre aussi les
 * changements venus du code (bouton « Auto », chargement d'un binding).
 */
@Directive({ selector: 'input[type="range"]' })
export class RangeFill implements AfterViewInit, DoCheck {
  private el = inject(ElementRef<HTMLInputElement>)

  @HostListener('input')
  @HostListener('change')
  update(): void {
    const i = this.el.nativeElement as HTMLInputElement
    const min = Number(i.min || 0)
    const max = Number(i.max || 100)
    const span = max - min || 1
    i.style.setProperty('--pct', `${((Number(i.value) - min) / span) * 100}%`)
  }

  ngAfterViewInit(): void {
    this.update()
  }

  ngDoCheck(): void {
    this.update()
  }
}
